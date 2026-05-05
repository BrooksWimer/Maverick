import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

class CapturedAdapter implements ExecutionBackendAdapter {
  readonly name = "captured";
  readonly turnRequests: TurnRequest[] = [];
  private readonly threads = new Map<string, ExecutionThread>();
  private nextThreadId = 1;
  draftBody = "# Roadmap\n\n## Milestone 1\n\nShip the autonomous lifecycle.\n";

  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> { this.threads.clear(); }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread = { id: `thread-${this.nextThreadId++}`, cwd, status: "idle" as const };
    this.threads.set(thread.id, thread);
    return thread;
  }
  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    return this.threads.get(threadId) ?? null;
  }
  async startTurn(request: TurnRequest): Promise<TurnResult> {
    this.turnRequests.push(request);
    return { backendTurnId: "t1", status: "completed", output: this.draftBody, summary: "drafted" };
  }
  async steerTurn(_r: SteerRequest): Promise<void> {}
  async interruptTurn(_t: string): Promise<void> {}
  async resolveApproval(_t: string, _a: string, _ok: boolean): Promise<void> {}
  async startReview(_r: ReviewRequest): Promise<ReviewResult> {
    return { findings: "clean", severity: "clean", suggestions: [] };
  }
  onOutput(_cb: (threadId: string, content: string, isPartial: boolean) => void): void {}
  onApprovalRequest(_cb: (threadId: string, request: ApprovalRequest) => void): void {}
}

describe("Orchestrator project bootstrap", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-bootstrap-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Agents doctrine.", "utf8");
    writeFileSync(join(repoPath, "README.md"), "# My Project\n\nThis project does X.", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo","version":"1.2.3"}', "utf8");
    mkdirSync(join(repoPath, "src", "core"), { recursive: true });
    writeFileSync(join(repoPath, "src", "index.ts"), "export {};", "utf8");
    writeFileSync(join(repoPath, "src", "core", "engine.ts"), "export {};", "utf8");
    mkdirSync(join(repoPath, "docs", "maverick"), { recursive: true });

    initDatabase(join(tempDir, "orchestrator.db"));

    config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: { executionBackend: { type: "mock", responseDelay: 0 } },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          workspaceKind: "notes",
          productionBranch: "main",
          executionBackend: { type: "mock", responseDelay: 0 },
          claudePlanning: { enabled: true, autoOnPlanningState: false, model: "sonnet" },
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

  it("drafts PROJECT_ROADMAP.md from repo signals on first call", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const adapter = new CapturedAdapter();
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = adapter;

    const result = await orchestrator.bootstrapProjectRoadmap("maverick");
    expect(result.filePath).toContain("PROJECT_ROADMAP.md");
    expect(existsSync(result.filePath)).toBe(true);
    expect(result.snippet).toContain("Milestone 1");

    const written = readFileSync(result.filePath, "utf8");
    expect(written).toContain("Milestone 1");

    expect(adapter.turnRequests).toHaveLength(1);
    const instruction = adapter.turnRequests[0]?.instruction ?? "";
    expect(instruction).toContain("My Project");
    expect(instruction).toContain('"name":"repo"');
    expect(instruction).toContain("src/core");
    expect(instruction).toContain("Agents doctrine");
  });

  it("refuses to overwrite an existing PROJECT_ROADMAP.md", async () => {
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_ROADMAP.md"),
      "# already here",
      "utf8",
    );

    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const adapter = new CapturedAdapter();
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = adapter;

    await expect(orchestrator.bootstrapProjectRoadmap("maverick")).rejects.toThrow(/already exists/);
    expect(adapter.turnRequests).toHaveLength(0);
  });
});
