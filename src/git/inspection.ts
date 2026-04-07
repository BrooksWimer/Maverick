import { execFile } from "node:child_process";

export type GitCommitSummary = {
  hash: string;
  committedAt: string;
  subject: string;
};

export type GitWorkspaceInspection = {
  cwd: string;
  isGitRepository: boolean;
  branch: string | null;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  aheadCount: number;
  behindCount: number;
  latestCommit: GitCommitSummary | null;
  error: string | null;
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

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

function parseBranchHeader(header: string): { branch: string | null; aheadCount: number; behindCount: number } {
  const body = header.replace(/^##\s*/, "").trim();
  if (!body) {
    return { branch: null, aheadCount: 0, behindCount: 0 };
  }

  let branch: string | null;
  if (body.startsWith("No commits yet on ")) {
    branch = body.replace("No commits yet on ", "").trim();
  } else if (body.startsWith("HEAD ")) {
    branch = null;
  } else {
    branch = body.split("...")[0]?.split(" ")[0] ?? null;
  }

  const aheadMatch = body.match(/ahead (\d+)/i);
  const behindMatch = body.match(/behind (\d+)/i);

  return {
    branch,
    aheadCount: aheadMatch ? Number.parseInt(aheadMatch[1], 10) : 0,
    behindCount: behindMatch ? Number.parseInt(behindMatch[1], 10) : 0,
  };
}

async function readLatestCommit(cwd: string): Promise<GitCommitSummary | null> {
  try {
    const { stdout } = await execGit(["log", "-1", "--pretty=format:%H%x1f%cI%x1f%s"], cwd);
    if (!stdout) {
      return null;
    }

    const [hash, committedAt, subject] = stdout.split("\u001f");
    if (!hash || !committedAt || !subject) {
      return null;
    }

    return {
      hash,
      committedAt,
      subject,
    };
  } catch {
    return null;
  }
}

export async function inspectGitWorkspace(cwd: string): Promise<GitWorkspaceInspection> {
  try {
    const { stdout } = await execGit(["status", "--porcelain=v1", "--branch"], cwd);
    const lines = stdout ? stdout.split(/\r?\n/) : [];
    const header = lines.find((line) => line.startsWith("##")) ?? "";
    const branch = parseBranchHeader(header);

    let stagedCount = 0;
    let unstagedCount = 0;
    let untrackedCount = 0;

    for (const line of lines) {
      if (!line || line.startsWith("##")) {
        continue;
      }

      if (line.startsWith("??")) {
        untrackedCount += 1;
        continue;
      }

      const staged = line[0];
      const unstaged = line[1];
      if (staged && staged !== " ") {
        stagedCount += 1;
      }
      if (unstaged && unstaged !== " ") {
        unstagedCount += 1;
      }
    }

    return {
      cwd,
      isGitRepository: true,
      branch: branch.branch,
      clean: stagedCount === 0 && unstagedCount === 0 && untrackedCount === 0,
      stagedCount,
      unstagedCount,
      untrackedCount,
      aheadCount: branch.aheadCount,
      behindCount: branch.behindCount,
      latestCommit: await readLatestCommit(cwd),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not a git repository")) {
      return {
        cwd,
        isGitRepository: false,
        branch: null,
        clean: true,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        aheadCount: 0,
        behindCount: 0,
        latestCommit: null,
        error: null,
      };
    }

    return {
      cwd,
      isGitRepository: true,
      branch: null,
      clean: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      aheadCount: 0,
      behindCount: 0,
      latestCommit: null,
      error: message,
    };
  }
}
