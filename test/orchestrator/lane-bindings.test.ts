import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase, projects } from "../../src/state/index.js";

describe("Orchestrator Discord thread binding repair", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-lane-bindings-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    initDatabase(join(tempDir, "orchestrator.db"));

    config = OrchestratorConfigSchema.parse({
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
          productionBranch: "main",
          defaultLanes: [
            {
              id: "discord-routing",
              baseBranch: "discord-routing",
            },
          ],
        },
        {
          id: "portfolio-resume",
          name: "Portfolio & Resume",
          repoPath,
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
        {
          id: "netwise",
          name: "Astra",
          repoPath,
          productionBranch: "master",
          epicBranches: [
            {
              id: "router-admin-ingestion",
              branch: "codex/router-admin-ingestion-epic",
              workstreamPrefix: "router-admin-ingestion",
            },
          ],
        },
      ],
    });

    for (const project of config.projects) {
      projects.upsert({
        id: project.id,
        name: project.name,
        repo_path: project.repoPath,
        config_json: JSON.stringify(project),
      });
    }
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("repairs a stale Portfolio thread binding to use the durable portfolio branch", () => {
    const orchestrator = new Orchestrator(config);
    orchestrator.upsertDiscordThreadBinding({
      threadId: "portfolio-thread",
      parentChannelId: "portfolio-forum",
      projectId: "portfolio-resume",
      lane: "portfolio",
      baseBranch: "master",
      assistantEnabled: true,
      ownerInstanceId: "linux",
      source: "thread-title",
    });

    const report = orchestrator.repairDiscordThreadBindings();
    const repaired = orchestrator.getDiscordThreadBinding("portfolio-thread");

    expect(report.changed).toHaveLength(1);
    expect(repaired?.lane).toBe("portfolio");
    expect(repaired?.base_branch).toBe("portfolio");
  });

  it("repairs a stale Maverick lane binding away from production", () => {
    const orchestrator = new Orchestrator(config);
    orchestrator.upsertDiscordThreadBinding({
      threadId: "discord-routing-thread",
      parentChannelId: "maverick-forum",
      projectId: "maverick",
      lane: "discord-routing",
      baseBranch: "main",
      assistantEnabled: true,
      ownerInstanceId: "linux",
      source: "thread-title",
    });

    const report = orchestrator.repairDiscordThreadBindings();
    const repaired = orchestrator.getDiscordThreadBinding("discord-routing-thread");

    expect(report.changed).toHaveLength(1);
    expect(repaired?.lane).toBe("discord-routing");
    expect(repaired?.base_branch).toBe("discord-routing");
  });

  it("repairs an epic binding to the configured durable epic branch", () => {
    const orchestrator = new Orchestrator(config);
    orchestrator.upsertDiscordThreadBinding({
      threadId: "router-thread",
      parentChannelId: "netwise-forum",
      projectId: "netwise",
      epicId: "router-admin-ingestion",
      lane: "router-admin-ingestion",
      baseBranch: "master",
      assistantEnabled: true,
      ownerInstanceId: "linux",
      source: "thread-title",
    });

    const report = orchestrator.repairDiscordThreadBindings();
    const repaired = orchestrator.getDiscordThreadBinding("router-thread");

    expect(report.changed).toHaveLength(1);
    expect(repaired?.epic_id).toBe("router-admin-ingestion");
    expect(repaired?.lane).toBe("router-admin-ingestion");
    expect(repaired?.base_branch).toBe("codex/router-admin-ingestion-epic");
  });
});
