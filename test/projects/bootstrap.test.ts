import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema } from "../../src/config/index.js";
import { ensureProjectBootstrap, ensureWorktreeBootstrap } from "../../src/projects/bootstrap.js";

describe("project bootstrap doctrine", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs the expanded doctrine skills and updated AGENTS template into project and worktree roots", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-bootstrap-"));
    tempDirs.push(tempDir);

    const repoPath = join(tempDir, "repo");
    const worktreePath = join(tempDir, "worktree");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreePath, { recursive: true });

    const config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: {
          type: "mock",
          responseDelay: 0,
        },
      },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
    });
    const project = config.projects[0];

    ensureProjectBootstrap(project);
    ensureWorktreeBootstrap(project, worktreePath);

    const expectedSkills = [
      "search-first",
      "iterative-retrieval",
      "tdd-workflow",
      "security-review",
      "deployment-patterns",
      "workstream-intake",
      "verify",
      "prepare-review",
    ];

    for (const root of [repoPath, worktreePath]) {
      const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8");
      expect(agentsMd).toContain("Doctrine Skills");
      expect(agentsMd).toContain("does not rely on local harness hooks");

      for (const skillName of expectedSkills) {
        const skillPath = join(root, ".agents", "skills", skillName, "SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
      }
    }

    const verifySkill = readFileSync(join(repoPath, ".agents", "skills", "verify", "SKILL.md"), "utf8");
    expect(verifySkill).toContain("tdd-workflow");
    expect(verifySkill).toContain("deployment-patterns");
  });
});
