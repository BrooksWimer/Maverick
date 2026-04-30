import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFinishedWorkstreamBranch,
  finishWorkstreamBranch,
  promoteLaneBranch,
  verifyLanePromotion,
} from "../../src/git/lifecycle.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd: string, fileName: string, contents: string, message: string): string {
  writeFileSync(join(cwd, fileName), contents, "utf8");
  git(cwd, ["add", fileName]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

describe("git lifecycle helpers", () => {
  let tempDir: string;
  let origin: string;
  let repo: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-git-lifecycle-"));
    origin = join(tempDir, "origin.git");
    repo = join(tempDir, "repo");

    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "--bare"]);
    git(tempDir, ["clone", origin, repo]);
    git(repo, ["config", "user.email", "maverick@example.test"]);
    git(repo, ["config", "user.name", "Maverick Test"]);
    commitFile(repo, "README.md", "# Test\n", "initial");
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["push", "-u", "origin", "main"]);
    git(repo, ["checkout", "-b", "portfolio"]);
    git(repo, ["push", "-u", "origin", "portfolio"]);
    git(repo, ["checkout", "-b", "maverick/test/add-images", "portfolio"]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("finishes a disposable workstream branch into the durable lane branch", async () => {
    const workstreamHead = commitFile(repo, "image.txt", "image metadata\n", "add image");

    const result = await finishWorkstreamBranch({
      cwd: repo,
      workstreamBranch: "maverick/test/add-images",
      durableBranch: "portfolio",
    });

    expect(result.status).toBe("merged");
    expect(result.pushed).toBe(true);
    expect(result.headSha).toBe(workstreamHead);
    expect(git(repo, ["ls-remote", "origin", "refs/heads/portfolio"]).split(/\s+/)[0]).toBe(workstreamHead);
  });

  it("verifies and promotes a durable lane branch to production", async () => {
    git(repo, ["checkout", "portfolio"]);
    const laneHead = commitFile(repo, "portfolio.txt", "ready\n", "prepare portfolio lane");
    git(repo, ["push", "origin", "portfolio"]);

    const readiness = await verifyLanePromotion({
      repoPath: repo,
      laneBranch: "portfolio",
      productionBranch: "main",
    });

    expect(readiness.status).toBe("ready");

    const promotion = await promoteLaneBranch({
      repoPath: repo,
      laneBranch: "portfolio",
      productionBranch: "main",
    });

    expect(promotion.status).toBe("merged");
    expect(promotion.pushed).toBe(true);
    expect(git(repo, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(laneHead);
  });

  it("blocks promotion when production is not an ancestor of the lane", async () => {
    git(repo, ["checkout", "main"]);
    commitFile(repo, "hotfix.txt", "production\n", "production hotfix");
    git(repo, ["push", "origin", "main"]);

    git(repo, ["checkout", "portfolio"]);
    commitFile(repo, "portfolio.txt", "lane\n", "lane update");
    git(repo, ["push", "origin", "portfolio"]);

    const result = await verifyLanePromotion({
      repoPath: repo,
      laneBranch: "portfolio",
      productionBranch: "main",
    });

    expect(result.status).toBe("blocked");
    expect(result.pushed).toBe(false);
    expect(result.reason).toContain("not an ancestor");
  });

  it("cleans only a disposable worktree branch after the durable lane contains its head", async () => {
    git(repo, ["checkout", "portfolio"]);
    const worktreePath = join(tempDir, "cleanup-worktree");
    git(repo, ["worktree", "add", "-b", "maverick/test/cleanup", worktreePath, "portfolio"]);
    const workstreamHead = commitFile(worktreePath, "cleanup.txt", "clean\n", "ready to clean");
    git(worktreePath, ["push", "origin", "HEAD:refs/heads/portfolio"]);

    const result = await cleanupFinishedWorkstreamBranch({
      repoPath: repo,
      worktreePath,
      workstreamBranch: "maverick/test/cleanup",
      durableBranch: "portfolio",
    });

    expect(result.status).toBe("cleaned");
    expect(result.worktreeRemoved).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, ["ls-remote", "origin", "refs/heads/portfolio"]).split(/\s+/)[0]).toBe(workstreamHead);
    expect(git(repo, ["branch", "--list", "maverick/test/cleanup"])).toBe("");
  });
});
