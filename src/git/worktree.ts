import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type WorktreeProvisionResult = {
  cwd: string;
  branch: string | null;
  mode: "worktree" | "legacy-root" | "notes";
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "workstream";
}

export function deriveWorktreeNames(params: {
  projectId: string;
  workstreamId: string;
  name: string;
  lane?: string | null;
}) {
  const slug = slugify(params.name);
  const shortId = params.workstreamId.split("-")[0] ?? params.workstreamId;
  const laneSegment = params.lane ? slugify(params.lane) : null;
  const leafName = `${slug}-${shortId}`;
  const relativeSegments = [params.projectId, ...(laneSegment ? [laneSegment] : []), leafName];
  const branch = ["maverick", params.projectId, ...(laneSegment ? [laneSegment] : []), leafName].join("/");

  return {
    laneSegment,
    leafName,
    relativeSegments,
    branch,
  };
}

function execGit(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr?.trim() || stdout?.trim() || error.message;
        rejectPromise(new Error(`git ${args.join(" ")} failed: ${details}`));
        return;
      }

      resolvePromise({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--show-toplevel"], repoPath);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not a git repository")) {
      return false;
    }

    throw error;
  }
}

async function gitRefExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await execGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function fetchRemoteBranchIfAvailable(repoPath: string, branch: string): Promise<void> {
  try {
    await execGit(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], repoPath);
  } catch {
    // Some test/local repositories intentionally have no origin or no matching remote branch.
  }
}

async function fetchRemoteBranch(repoPath: string, branch: string): Promise<void> {
  await execGit(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], repoPath);
}

async function resolveWorktreeBaseRef(repoPath: string, baseRef?: string): Promise<string> {
  if (!baseRef) {
    return "HEAD";
  }

  await fetchRemoteBranchIfAvailable(repoPath, baseRef);

  const remoteRef = `refs/remotes/origin/${baseRef}`;
  if (await gitRefExists(repoPath, remoteRef)) {
    return remoteRef;
  }

  if (await gitRefExists(repoPath, baseRef)) {
    return baseRef;
  }

  throw new Error(
    `Base ref "${baseRef}" was not found locally or at origin/${baseRef}. Fetch or create the durable lane branch before starting this workstream.`
  );
}

export async function provisionWorktree(params: {
  repoPath: string;
  projectId: string;
  workstreamId: string;
  name: string;
  workspaceKind?: "git" | "notes";
  lane?: string | null;
  baseRef?: string;
  generatedRoot?: string;
}): Promise<WorktreeProvisionResult> {
  if (params.workspaceKind === "notes") {
    return {
      cwd: params.repoPath,
      branch: null,
      mode: "notes",
    };
  }

  if (!(await isGitRepository(params.repoPath))) {
    return {
      cwd: params.repoPath,
      branch: null,
      mode: "legacy-root",
    };
  }

  const names = deriveWorktreeNames(params);
  const generatedRoot = params.generatedRoot ?? resolve(process.cwd(), ".generated", "worktrees");
  const worktreePath = resolve(generatedRoot, ...names.relativeSegments);
  const baseRef = await resolveWorktreeBaseRef(params.repoPath, params.baseRef);

  mkdirSync(dirname(worktreePath), { recursive: true });
  await execGit(["worktree", "add", "-b", names.branch, worktreePath, baseRef], params.repoPath);

  return {
    cwd: worktreePath,
    branch: names.branch,
    mode: "worktree",
  };
}

export async function recoverWorktreeForBranch(params: {
  repoPath: string;
  projectId: string;
  workstreamId: string;
  name: string;
  workspaceKind?: "git" | "notes";
  lane?: string | null;
  branch: string | null;
  generatedRoot?: string;
}): Promise<WorktreeProvisionResult> {
  if (params.workspaceKind === "notes") {
    return {
      cwd: params.repoPath,
      branch: null,
      mode: "notes",
    };
  }

  if (!(await isGitRepository(params.repoPath))) {
    return {
      cwd: params.repoPath,
      branch: null,
      mode: "legacy-root",
    };
  }

  if (!params.branch) {
    throw new Error("Cannot recover a git worktree without a stored disposable workstream branch.");
  }

  const names = deriveWorktreeNames(params);
  const generatedRoot = params.generatedRoot ?? resolve(process.cwd(), ".generated", "worktrees");
  const worktreePath = resolve(generatedRoot, ...names.relativeSegments);
  const remoteRef = `refs/remotes/origin/${params.branch}`;
  const localRef = `refs/heads/${params.branch}`;

  await fetchRemoteBranch(params.repoPath, params.branch);

  mkdirSync(dirname(worktreePath), { recursive: true });
  if (await gitRefExists(params.repoPath, localRef)) {
    await execGit(["worktree", "add", worktreePath, params.branch], params.repoPath);
  } else if (await gitRefExists(params.repoPath, remoteRef)) {
    await execGit(["worktree", "add", "-b", params.branch, worktreePath, remoteRef], params.repoPath);
  } else {
    throw new Error(`Disposable workstream branch "${params.branch}" was not found at origin.`);
  }

  return {
    cwd: worktreePath,
    branch: params.branch,
    mode: "worktree",
  };
}
