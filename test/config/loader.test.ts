import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

function writeConfig(tempDir: string, repoPath: string, docPath: string) {
  const configPath = join(tempDir, "control-plane.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    defaults: {},
    projects: [
      {
        id: "netwise",
        name: "Netwise",
        repoPath,
        epicBranches: [
          {
            id: "router-admin-ingestion",
            branch: "codex/router-admin-ingestion-epic",
            workstreamPrefix: "router-admin-ingestion",
            charter: {
              summary: "Authenticated router admin ingestion is a durable product capability.",
              bullets: [
                "Start with Xfinity without overfitting to it.",
              ],
              docs: [
                {
                  path: docPath,
                  purpose: "Durable repo-owned notes.",
                },
              ],
            },
          },
        ],
      },
    ],
  }, null, 2));
  return configPath;
}

describe("loadConfig epic charters", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts repo-relative epic charter docs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-config-"));
    tempDirs.push(tempDir);

    const repoPath = join(tempDir, "netwise");
    mkdirSync(join(repoPath, "agent", "docs"), { recursive: true });
    writeFileSync(join(repoPath, "agent", "docs", "WIFI_STRATEGY_CATALOG.md"), "# Notes\n");

    const config = loadConfig(writeConfig(tempDir, repoPath, "agent/docs/WIFI_STRATEGY_CATALOG.md"));
    expect(config.projects[0].epicBranches[0].charter?.docs[0]?.path).toBe("agent/docs/WIFI_STRATEGY_CATALOG.md");
  });

  it("rejects epic charter docs that escape the project repo", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-config-"));
    tempDirs.push(tempDir);

    const repoPath = join(tempDir, "netwise");
    mkdirSync(repoPath, { recursive: true });

    const configPath = writeConfig(tempDir, repoPath, "..\\outside.md");
    expect(() => loadConfig(configPath)).toThrow(/escapes repoPath/);
  });
});
