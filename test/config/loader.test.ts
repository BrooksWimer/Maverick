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

  it("merges inherited config files by project id and discord route", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-config-"));
    tempDirs.push(tempDir);

    const netwiseRepoPath = join(tempDir, "netwise");
    const maverickRepoPath = join(tempDir, "maverick");
    mkdirSync(join(netwiseRepoPath, "agent", "docs"), { recursive: true });
    mkdirSync(maverickRepoPath, { recursive: true });
    writeFileSync(join(netwiseRepoPath, "agent", "docs", "WIFI_STRATEGY_CATALOG.md"), "# Notes\n");

    const sharedConfigPath = join(tempDir, "shared.json");
    writeFileSync(sharedConfigPath, JSON.stringify({
      version: 1,
      defaults: {},
      projects: [
        {
          id: "netwise",
          name: "Netwise",
          epicBranches: [
            {
              id: "router-admin-ingestion",
              branch: "codex/router-admin-ingestion-epic",
              workstreamPrefix: "router-admin-ingestion",
              charter: {
                summary: "Router admin ingestion is durable.",
                docs: [
                  {
                    path: "agent/docs/WIFI_STRATEGY_CATALOG.md",
                    purpose: "Durable notes."
                  }
                ]
              }
            }
          ]
        }
      ],
      discord: {
        enabled: true,
        routes: [
          {
            projectId: "netwise",
            channelId: "111",
            purpose: "workstreams"
          }
        ]
      }
    }, null, 2));

    const configPath = join(tempDir, "control-plane.json");
    writeFileSync(configPath, JSON.stringify({
      extends: "./shared.json",
      projects: [
        {
          id: "netwise",
          repoPath: netwiseRepoPath
        },
        {
          id: "maverick",
          name: "Maverick",
          repoPath: maverickRepoPath,
          defaultWorktreeBaseBranch: "main"
        }
      ],
      discord: {
        routes: [
          {
            projectId: "maverick",
            channelId: "222",
            purpose: "workstreams"
          }
        ]
      }
    }, null, 2));

    const config = loadConfig(configPath);
    expect(config.projects.find((project) => project.id === "netwise")?.repoPath).toBe(netwiseRepoPath);
    expect(config.projects.find((project) => project.id === "netwise")?.epicBranches).toHaveLength(1);
    expect(config.projects.find((project) => project.id === "maverick")?.repoPath).toBe(maverickRepoPath);
    expect(config.discord.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: "netwise", channelId: "111" }),
      expect.objectContaining({ projectId: "maverick", channelId: "222" }),
    ]));
  });

  it("migrates legacy default lanes into epic branches and preserves assistant ownership", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-config-"));
    tempDirs.push(tempDir);

    const repoPath = join(tempDir, "work");
    mkdirSync(repoPath, { recursive: true });

    const configPath = join(tempDir, "control-plane.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      defaults: {},
      projects: [
        {
          id: "work",
          name: "Work",
          repoPath,
          defaultLanes: [
            {
              id: "job-ops",
              baseBranch: "main",
              assistantEnabled: true,
              ownerInstanceId: "windows",
            },
          ],
        },
      ],
      discord: {
        enabled: true,
        routes: [
          {
            projectId: "work",
            channelId: "333",
            purpose: "workstreams",
            lane: "job-ops",
            assistantEnabled: true,
            ownerInstanceId: "windows",
          },
        ],
      },
    }, null, 2));

    const config = loadConfig(configPath);
    expect(config.projects[0].defaultLanes).toEqual([]);
    expect(config.projects[0].epicBranches[0]).toMatchObject({
      id: "job-ops",
      branch: "main",
    });
    expect(config.projects[0].requireEpicForWorktree).toBe(true);
    expect(config.discord.routes[0]).toMatchObject({
      epicId: "job-ops",
      assistantEnabled: true,
      ownerInstanceId: "windows",
    });
  });
});
