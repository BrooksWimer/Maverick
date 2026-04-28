import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema, type ProjectConfig } from "../../src/config/index.js";
import { auditRemoteBranches, collectRequiredBranches } from "../../src/git/branch-audit.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd: string, fileName: string, contents: string, message: string): void {
  writeFileSync(join(cwd, fileName), contents, "utf8");
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "-m", message]);
}

describe("branch audit helpers", () => {
  let tempDir: string;
  let origin: string;
  let repo: string;
  let project: ProjectConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-branch-audit-"));
    origin = join(tempDir, "origin.git");
    repo = join(tempDir, "repo");

    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "--bare"]);
    git(tempDir, ["clone", origin, repo]);
    git(repo, ["config", "user.email", "maverick@example.test"]);
    git(repo, ["config", "user.name", "Maverick Test"]);
    commitFile(repo, "README.md", "# Test\n", "initial");
    git(repo, ["branch", "-M", "master"]);
    git(repo, ["push", "-u", "origin", "master"]);
    git(repo, ["checkout", "-b", "portfolio"]);
    git(repo, ["push", "-u", "origin", "portfolio"]);

    project = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: {
          type: "mock",
          responseDelay: 0,
        },
      },
      projects: [
        {
          id: "portfolio-resume",
          name: "Portfolio & Resume",
          repoPath: repo,
          productionBranch: "master",
          defaultLanes: [
            {
              id: "portfolio",
              baseBranch: "portfolio",
            },
            {
              id: "resume",
              baseBranch: "resume",
            },
          ],
        },
      ],
    }).projects[0];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("collects production and durable lane branches without duplicates", () => {
    expect(collectRequiredBranches(project).map((branch) => branch.branch)).toEqual([
      "master",
      "portfolio",
      "resume",
    ]);
  });

  it("reports missing durable branches without creating them", async () => {
    const audit = await auditRemoteBranches(project);

    expect(audit.present.map((branch) => branch.branch)).toEqual(["master", "portfolio"]);
    expect(audit.missing.map((branch) => branch.branch)).toEqual(["resume"]);
    expect(git(repo, ["ls-remote", "origin", "refs/heads/resume"])).toBe("");
  });
});
