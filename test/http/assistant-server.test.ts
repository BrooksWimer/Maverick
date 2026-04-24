import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantService } from "../../src/assistant/index.js";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import { createHttpServer } from "../../src/http/server.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase } from "../../src/state/index.js";

describe("HTTP assistant routes", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;
  let app: Awaited<ReturnType<typeof createHttpServer>> | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-http-assistant-"));
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
      assistant: {
        enabled: true,
        agentProjectId: "maverick",
        timeZone: "America/New_York",
      },
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

  it("serves assistant agenda and task endpoints", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const assistant = createAssistantService(config);

    await assistant.processIncomingMessage({
      source: "api",
      body: "Pick up dry cleaning and ask about tailoring",
    });

    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
      assistant,
      assistantConfig: config.assistant,
    });

    const tasksResponse = await app.inject({
      method: "GET",
      url: "/api/assistant/tasks",
    });
    expect(tasksResponse.statusCode).toBe(200);
    expect(tasksResponse.json()).toHaveLength(1);

    const agendaResponse = await app.inject({
      method: "GET",
      url: "/api/assistant/agenda",
    });
    expect(agendaResponse.statusCode).toBe(200);
    const agendaPayload = agendaResponse.json() as Record<string, unknown>;
    expect(Array.isArray(agendaPayload.inboxTasks)).toBe(true);

    const searchResponse = await app.inject({
      method: "GET",
      url: "/api/assistant/search?q=dry%20cleaning",
    });
    expect(searchResponse.statusCode).toBe(200);
    const searchPayload = searchResponse.json() as Array<Record<string, unknown>>;
    expect(searchPayload[0]?.title).toContain("dry cleaning");
  });
});
