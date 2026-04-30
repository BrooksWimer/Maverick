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

  it("protects repository state operations with the bearer token", async () => {
    const previousToken = process.env.MAVERICK_STATE_TOKEN;
    process.env.MAVERICK_STATE_TOKEN = "state-secret";

    try {
      orchestrator = new Orchestrator(config);
      await orchestrator.initialize();
      app = await createHttpServer(orchestrator, {
        host: "127.0.0.1",
        port: 0,
      });

      const unauthorized = await app.inject({
        method: "POST",
        url: "/internal/state/operation",
        payload: {
          repository: "projects",
          method: "list",
          args: [],
        },
      });
      expect(unauthorized.statusCode).toBe(401);

      const authorized = await app.inject({
        method: "POST",
        url: "/internal/state/operation",
        headers: {
          authorization: "Bearer state-secret",
        },
        payload: {
          repository: "projects",
          method: "upsert",
          args: [
            {
              id: "api-project",
              name: "API Project",
              repo_path: repoPath,
              config_json: "{}",
            },
          ],
        },
      });

      expect(authorized.statusCode).toBe(200);
      const payload = authorized.json() as { ok: boolean; result: { id: string } };
      expect(payload.ok).toBe(true);
      expect(payload.result.id).toBe("api-project");
    } finally {
      process.env.MAVERICK_STATE_TOKEN = previousToken;
    }
  });
});
