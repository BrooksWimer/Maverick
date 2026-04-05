import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type WorktreeProvisionResult = {
  cwd: string;
  branch: string | null;
  mode: "worktree" | "shared-root";
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

export async function provisionWorktree(params: {
  repoPath: string;
  projectId: string;
  workstreamId: string;
  name: string;
  generatedRoot?: string;
}): Promise<WorktreeProvisionResult> {
  if (!(await isGitRepository(params.repoPath))) {
    return {
      cwd: params.repoPath,
      branch: null,
      mode: "shared-root",
    };
  }

  const slug = slugify(params.name);
  const shortId = params.workstreamId.split("-")[0] ?? params.workstreamId;
  const branch = `maverick/${params.projectId}/${slug}-${shortId}`;
  const generatedRoot = params.generatedRoot ?? resolve(process.cwd(), ".generated", "worktrees");
  const worktreePath = resolve(generatedRoot, params.projectId, `${slug}-${shortId}`);

  mkdirSync(dirname(worktreePath), { recursive: true });
  await execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], params.repoPath);

  return {
    cwd: worktreePath,
    branch,
    mode: "worktree",
  };
}
