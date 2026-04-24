import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import { createHttpServer } from "../../src/http/server.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase } from "../../src/state/index.js";

describe("HTTP workstream status route", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;
  let app: Awaited<ReturnType<typeof createHttpServer>> | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-http-status-"));
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
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("returns the derived workstream status snapshot", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "http status",
    });

    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/workstreams/${workstream.id}/status`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, unknown>;
    expect(payload.workstreamId).toBe(workstream.id);
    expect(payload.workstreamName).toBe("http status");
    expect(typeof payload.health).toBe("string");
    expect(typeof payload.nextAction).toBe("string");
  });
});
