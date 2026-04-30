import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import type {
  ApprovalRequest,
  ExecutionBackendAdapter,
  ExecutionThread,
  ReviewRequest,
  ReviewResult,
  SteerRequest,
  TurnRequest,
  TurnResult,
} from "../../src/codex/index.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase } from "../../src/state/index.js";

class CaptureAdapter implements ExecutionBackendAdapter {
  readonly name = "capture";
  lastTurnRequest: TurnRequest | null = null;
  private readonly threads = new Map<string, ExecutionThread>();

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.threads.clear();
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread = {
      id: "capture-thread",
      cwd,
      status: "idle" as const,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    this.lastTurnRequest = request;
    return {
      backendTurnId: "capture-turn",
      status: "completed",
      output: "ok",
      summary: "ok",
      filesChanged: [],
    };
  }

  async steerTurn(_request: SteerRequest): Promise<void> {}

  async interruptTurn(_threadId: string): Promise<void> {}

  async resolveApproval(_threadId: string, _approvalId: string, _approved: boolean): Promise<void> {}

  async startReview(_request: ReviewRequest): Promise<ReviewResult> {
    return {
      findings: "clean",
      severity: "clean",
      suggestions: [],
    };
  }

  onOutput(_callback: (threadId: string, content: string, isPartial: boolean) => void): void {}

  onApprovalRequest(_callback: (threadId: string, request: ApprovalRequest) => void): void {}
}

describe("Orchestrator epic charter propagation", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-orchestrator-"));
    repoPath = join(tempDir, "netwise");
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
          id: "netwise",
          name: "Netwise",
          repoPath,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
          requireEpicForWorktree: true,
          epicBranches: [
            {
              id: "router-admin-ingestion",
              branch: "codex/router-admin-ingestion-epic",
              workstreamPrefix: "router-admin-ingestion",
              description: "Authenticated router admin ingestion and router-only inventory extraction",
              charter: {
                summary: "Router admin ingestion is a real Netwise product capability.",
                bullets: [
                  "Let users enter router admin credentials in the app and extract router-native network data.",
                  "Use Xfinity at http://10.0.0.1 first without hardcoding to one vendor UI.",
                ],
                docs: [
                  {
                    path: "agent/docs/WIFI_STRATEGY_CATALOG.md",
                    purpose: "Related repo-owned strategy notes.",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  });

  afterEach(async () => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("injects durable epic context into dispatched turns", async () => {
    const orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const captureAdapter = new CaptureAdapter();
    (orchestrator as { adapters: Map<string, ExecutionBackendAdapter> }).adapters.set("netwise", captureAdapter);

    const workstream = await orchestrator.createWorkstream({
      projectId: "netwise",
      name: "router admin capture",
      epicId: "router-admin-ingestion",
    });

    expect(workstream.epic_id).toBe("router-admin-ingestion");

    await orchestrator.dispatch(workstream.id, "Build the first router-admin ingestion slice.");

    expect(captureAdapter.lastTurnRequest?.instruction).toContain("Maverick durable epic context:");
    expect(captureAdapter.lastTurnRequest?.instruction).toContain("Epic: router-admin-ingestion");
    expect(captureAdapter.lastTurnRequest?.instruction).toContain("http://10.0.0.1");
    expect(captureAdapter.lastTurnRequest?.instruction).toContain("WIFI_STRATEGY_CATALOG.md");
    expect(captureAdapter.lastTurnRequest?.instruction).toContain("User request:\nBuild the first router-admin ingestion slice.");

    const turn = orchestrator.getWorkstreamTurns(workstream.id)[0];
    expect(turn?.instruction).toBe("Build the first router-admin ingestion slice.");

    const startedEvent = orchestrator
      .getRecentEvents()
      .find((event) => event.event_type === "turn.started");
    expect(startedEvent).toBeTruthy();
    expect(JSON.parse(startedEvent!.payload_json)).toMatchObject({
      epicId: "router-admin-ingestion",
      epicContextInjected: true,
    });

    await orchestrator.shutdown();
  });
});
