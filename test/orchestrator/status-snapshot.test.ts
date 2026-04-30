import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase, turns } from "../../src/state/index.js";

describe("Orchestrator workstream status snapshots", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-status-snapshot-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");

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
          workspaceKind: "notes",
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
    });
  });

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("marks a running implementation turn as quiet after 20 minutes without progress", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "quiet implementation",
    });
    await orchestrator.transitionState(workstream.id, "scope-defined");
    await orchestrator.transitionState(workstream.id, "plan-approved");

    const quietAt = new Date(Date.now() - 21 * 60 * 1000).toISOString();
    const turn = turns.create({
      workstream_id: workstream.id,
      instruction: "Implement the next slice.",
    });
    turns.update(turn.id, {
      status: "running",
      started_at: quietAt,
      last_progress_at: quietAt,
    });

    const snapshot = orchestrator.getWorkstreamStatusSnapshot(workstream.id);
    expect(snapshot?.state).toBe("implementation");
    expect(snapshot?.health).toBe("quiet");
    expect(snapshot?.activeOperation?.kind).toBe("implementation");
    expect(snapshot?.nextAction).toContain("Inspect the quiet run");
  });
});
