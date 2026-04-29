import { execFile } from "node:child_process";
import type { ProjectConfig } from "../config/schema.js";

type ExecResult = {
  stdout: string;
  stderr: string;
};

export interface RequiredBranch {
  projectId: string;
  kind: "production" | "lane" | "epic";
  id: string;
  branch: string;
}

export interface BranchAuditResult {
  projectId: string;
  repoPath: string;
  checked: RequiredBranch[];
  present: RequiredBranch[];
  missing: RequiredBranch[];
}

export interface BranchRepairResult extends BranchAuditResult {
  created: RequiredBranch[];
  skipped: RequiredBranch[];
}

function execGit(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (error, stdout, stderr) => {
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

function uniqueBranches(branches: RequiredBranch[]): RequiredBranch[] {
  const seen = new Set<string>();
  const result: RequiredBranch[] = [];
  for (const branch of branches) {
    const key = `${branch.projectId}:${branch.branch}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(branch);
  }

  return result;
}

export function collectRequiredBranches(project: ProjectConfig): RequiredBranch[] {
  if (project.workspaceKind !== "git") {
    return [];
  }

  return uniqueBranches([
    ...(project.productionBranch
      ? [{
          projectId: project.id,
          kind: "production" as const,
          id: "production",
          branch: project.productionBranch,
        }]
      : []),
    ...project.defaultLanes.map((lane) => ({
      projectId: project.id,
      kind: "epic" as const,
      id: lane.id,
      branch: lane.baseBranch,
    })),
    ...project.epicBranches.map((epic) => ({
      projectId: project.id,
      kind: "epic" as const,
      id: epic.id,
      branch: epic.branch,
    })),
  ]);
}

export async function auditRemoteBranches(project: ProjectConfig): Promise<BranchAuditResult> {
  const checked = collectRequiredBranches(project);
  if (checked.length === 0) {
    return {
      projectId: project.id,
      repoPath: project.repoPath,
      checked,
      present: [],
      missing: [],
    };
  }

  const output = await execGit(
    ["ls-remote", "--heads", "origin", ...checked.map((branch) => branch.branch)],
    project.repoPath,
  );
  const presentRefs = new Set(
    output.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((ref): ref is string => Boolean(ref))
  );

  const present = checked.filter((branch) => presentRefs.has(`refs/heads/${branch.branch}`));
  const missing = checked.filter((branch) => !presentRefs.has(`refs/heads/${branch.branch}`));

  return {
    projectId: project.id,
    repoPath: project.repoPath,
    checked,
    present,
    missing,
  };
}

export async function createMissingRemoteBranches(project: ProjectConfig): Promise<BranchRepairResult> {
  const audit = await auditRemoteBranches(project);
  const production = audit.checked.find((branch) => branch.kind === "production");
  if (!production) {
    return {
      ...audit,
      created: [],
      skipped: audit.missing,
    };
  }

  const created: RequiredBranch[] = [];
  const skipped: RequiredBranch[] = [];
  for (const branch of audit.missing) {
    if (branch.kind === "production") {
      skipped.push(branch);
      continue;
    }

    await execGit(["fetch", "origin", production.branch], project.repoPath);
    await execGit(["push", "origin", `refs/remotes/origin/${production.branch}:refs/heads/${branch.branch}`], project.repoPath);
    created.push(branch);
  }

  return {
    ...audit,
    created,
    skipped,
    missing: skipped,
    present: [...audit.present, ...created],
  };
}
