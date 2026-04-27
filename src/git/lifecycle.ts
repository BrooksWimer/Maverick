import { execFile } from "node:child_process";

type ExecResult = {
  stdout: string;
  stderr: string;
};

export type GitLifecycleStatus = "ready" | "merged" | "blocked";

export interface GitLifecycleResult {
  status: GitLifecycleStatus;
  sourceRef: string;
  targetBranch: string;
  pushed: boolean;
  headSha: string | null;
  targetShaBefore: string | null;
  targetShaAfter: string | null;
  reason: string | null;
  rollbackCommand: string | null;
}

function execGit(args: string[], cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args.join(" ")} failed: ${details}`));
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function remoteBranchRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function remoteHeadRef(branch: string): string {
  return `refs/heads/${branch}`;
}

async function tryGit(cwd: string, args: string[]): Promise<boolean> {
  try {
    await execGit(args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execGit(args, cwd);
  return result.stdout.trim();
}

export async function ensureCleanGitWorktree(cwd: string): Promise<void> {
  const status = await gitOutput(cwd, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(`Git worktree is dirty:\n${status}`);
  }
}

async function fetchBranch(cwd: string, branch: string): Promise<void> {
  await execGit(["fetch", "origin", `${remoteHeadRef(branch)}:${remoteBranchRef(branch)}`], cwd);
}

async function remoteBranchSha(cwd: string, branch: string): Promise<string | null> {
  const ref = remoteBranchRef(branch);
  const exists = await tryGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
  if (!exists) {
    return null;
  }

  return gitOutput(cwd, ["rev-parse", ref]);
}

async function isAncestor(cwd: string, ancestorRef: string, descendantRef: string): Promise<boolean> {
  return tryGit(cwd, ["merge-base", "--is-ancestor", ancestorRef, descendantRef]);
}

export async function finishWorkstreamBranch(params: {
  cwd: string;
  workstreamBranch: string;
  durableBranch: string;
}): Promise<GitLifecycleResult> {
  await ensureCleanGitWorktree(params.cwd);
  await fetchBranch(params.cwd, params.durableBranch);

  const currentBranch = await gitOutput(params.cwd, ["branch", "--show-current"]);
  if (currentBranch !== params.workstreamBranch) {
    throw new Error(
      `Workstream workspace is on branch "${currentBranch}", expected "${params.workstreamBranch}".`
    );
  }

  const headSha = await gitOutput(params.cwd, ["rev-parse", "HEAD"]);
  const durableRef = remoteBranchRef(params.durableBranch);
  const targetShaBefore = await remoteBranchSha(params.cwd, params.durableBranch);
  if (!targetShaBefore) {
    throw new Error(`Durable branch "${params.durableBranch}" was not found on origin.`);
  }

  const canFastForward = await isAncestor(params.cwd, durableRef, "HEAD");
  if (!canFastForward) {
    return {
      status: "blocked",
      sourceRef: params.workstreamBranch,
      targetBranch: params.durableBranch,
      pushed: false,
      headSha,
      targetShaBefore,
      targetShaAfter: targetShaBefore,
      reason: `Durable branch "${params.durableBranch}" is not an ancestor of the workstream branch.`,
      rollbackCommand: null,
    };
  }

  await execGit(["push", "origin", `HEAD:${remoteHeadRef(params.durableBranch)}`], params.cwd);
  await fetchBranch(params.cwd, params.durableBranch);
  const targetShaAfter = await remoteBranchSha(params.cwd, params.durableBranch);

  return {
    status: "merged",
    sourceRef: params.workstreamBranch,
    targetBranch: params.durableBranch,
    pushed: true,
    headSha,
    targetShaBefore,
    targetShaAfter,
    reason: null,
    rollbackCommand: targetShaBefore
      ? `git push origin ${targetShaBefore}:refs/heads/${params.durableBranch}`
      : null,
  };
}

export async function verifyLanePromotion(params: {
  repoPath: string;
  laneBranch: string;
  productionBranch: string;
}): Promise<GitLifecycleResult> {
  await ensureCleanGitWorktree(params.repoPath);
  await fetchBranch(params.repoPath, params.laneBranch);
  await fetchBranch(params.repoPath, params.productionBranch);

  const laneRef = remoteBranchRef(params.laneBranch);
  const productionRef = remoteBranchRef(params.productionBranch);
  const laneSha = await remoteBranchSha(params.repoPath, params.laneBranch);
  const productionSha = await remoteBranchSha(params.repoPath, params.productionBranch);

  if (!laneSha) {
    throw new Error(`Durable lane branch "${params.laneBranch}" was not found on origin.`);
  }
  if (!productionSha) {
    throw new Error(`Production branch "${params.productionBranch}" was not found on origin.`);
  }

  const canFastForward = await isAncestor(params.repoPath, productionRef, laneRef);
  if (!canFastForward) {
    return {
      status: "blocked",
      sourceRef: params.laneBranch,
      targetBranch: params.productionBranch,
      pushed: false,
      headSha: laneSha,
      targetShaBefore: productionSha,
      targetShaAfter: productionSha,
      reason: `Production branch "${params.productionBranch}" is not an ancestor of lane branch "${params.laneBranch}".`,
      rollbackCommand: null,
    };
  }

  return {
    status: "ready",
    sourceRef: params.laneBranch,
    targetBranch: params.productionBranch,
    pushed: false,
    headSha: laneSha,
    targetShaBefore: productionSha,
    targetShaAfter: productionSha,
    reason: null,
    rollbackCommand: null,
  };
}

export async function promoteLaneBranch(params: {
  repoPath: string;
  laneBranch: string;
  productionBranch: string;
}): Promise<GitLifecycleResult> {
  const readiness = await verifyLanePromotion(params);
  if (readiness.status === "blocked") {
    return readiness;
  }

  await execGit(
    [
      "push",
      "origin",
      `${remoteBranchRef(params.laneBranch)}:${remoteHeadRef(params.productionBranch)}`,
    ],
    params.repoPath,
  );
  await fetchBranch(params.repoPath, params.productionBranch);
  const targetShaAfter = await remoteBranchSha(params.repoPath, params.productionBranch);

  return {
    ...readiness,
    status: "merged",
    pushed: true,
    targetShaAfter,
    rollbackCommand: readiness.targetShaBefore
      ? `git push origin ${readiness.targetShaBefore}:refs/heads/${params.productionBranch}`
      : null,
  };
}
