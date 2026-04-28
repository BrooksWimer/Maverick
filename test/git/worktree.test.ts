import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveWorktreeNames, provisionWorktree } from "../../src/git/worktree.js";

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

describe("deriveWorktreeNames", () => {
  it("includes the epic lane in generated branch names and worktree paths", () => {
    const names = deriveWorktreeNames({
      projectId: "netwise",
      workstreamId: "dc7c0af4-5500-4311-9b25-ef8c408f2f86",
      name: "netwise laptop scanner v2",
      lane: "laptop-wifi-scanner",
    });

    expect(names.branch).toBe(
      "maverick/netwise/laptop-wifi-scanner/netwise-laptop-scanner-v2-dc7c0af4"
    );
    expect(names.relativeSegments).toEqual([
      "netwise",
      "laptop-wifi-scanner",
      "netwise-laptop-scanner-v2-dc7c0af4",
    ]);
  });

  it("preserves the legacy branch shape when no lane is provided", () => {
    const names = deriveWorktreeNames({
      projectId: "maverick",
      workstreamId: "12345678-1234-1234-1234-123456789abc",
      name: "control plane cleanup",
    });

    expect(names.branch).toBe("maverick/maverick/control-plane-cleanup-12345678");
    expect(names.relativeSegments).toEqual([
      "maverick",
      "control-plane-cleanup-12345678",
    ]);
  });

  it("can provision from an origin lane branch when no local branch exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-worktree-"));
    try {
      const origin = join(tempDir, "origin.git");
      const repo = join(tempDir, "repo");
      const generatedRoot = join(tempDir, "generated");

      mkdirSync(origin, { recursive: true });
      git(origin, ["init", "--bare"]);
      git(tempDir, ["clone", origin, repo]);
      git(repo, ["config", "user.email", "maverick@example.test"]);
      git(repo, ["config", "user.name", "Maverick Test"]);
      commitFile(repo, "README.md", "# Test\n", "initial");
      git(repo, ["branch", "-M", "master"]);
      git(repo, ["push", "-u", "origin", "master"]);
      git(repo, ["checkout", "-b", "portfolio"]);
      commitFile(repo, "portfolio.txt", "portfolio lane\n", "seed portfolio lane");
      git(repo, ["push", "-u", "origin", "portfolio"]);
      git(repo, ["checkout", "master"]);
      git(repo, ["branch", "-D", "portfolio"]);

      const workspace = await provisionWorktree({
        repoPath: repo,
        projectId: "portfolio-resume",
        workstreamId: "92b173d5-0000-4000-8000-000000000000",
        name: "adding images",
        lane: "portfolio",
        baseRef: "portfolio",
        generatedRoot,
      });

      expect(workspace.mode).toBe("worktree");
      expect(workspace.branch).toBe("maverick/portfolio-resume/portfolio/adding-images-92b173d5");
      expect(existsSync(join(workspace.cwd, "portfolio.txt"))).toBe(true);
      expect(git(workspace.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(workspace.branch);
    } finally {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
