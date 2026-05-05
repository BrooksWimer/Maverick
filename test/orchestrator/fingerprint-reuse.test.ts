import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

class QueuedAdapter implements ExecutionBackendAdapter {
  readonly name: string;
  readonly turnRequests: TurnRequest[] = [];
  private readonly threads = new Map<string, ExecutionThread>();
  private nextThreadId = 1;

  constructor(
    name: string,
    private readonly turnResults: TurnResult[],
  ) {
    this.name = name;
  }

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.threads.clear();
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread = {
      id: `${this.name}-thread-${this.nextThreadId++}`,
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
    this.turnRequests.push(request);
    const result = this.turnResults.shift();
    if (!result) {
      throw new Error(`No queued turn result for ${this.name}`);
    }
    return result;
  }

  async steerTurn(_request: SteerRequest): Promise<void> {}
  async interruptTurn(_threadId: string): Promise<void> {}
  async resolveApproval(_threadId: string, _approvalId: string, _approved: boolean): Promise<void> {}

  async startReview(_request: ReviewRequest): Promise<ReviewResult> {
    return { findings: "clean", severity: "clean", suggestions: [] };
  }

  onOutput(_callback: (threadId: string, content: string, isPartial: boolean) => void): void {}
  onApprovalRequest(_callback: (threadId: string, request: ApprovalRequest) => void): void {}
}

function readyPlanningOutput(suffix: string): TurnResult {
  const payload = {
    currentStateSummary: `Current ${suffix}`,
    recommendedNextSlice: "Move planning forward.",
    requiredAnswers: [],
    importantDecisions: [],
    draftExecutionPrompt: `Implement the slice (${suffix}).`,
    finalExecutionPrompt: `Implement the slice (${suffix}).`,
    remainingUnknowns: [],
    steps: [
      {
        order: 1,
        description: "Do the thing.",
        files: ["src/file.ts"],
        verification: "npm test",
        canParallelize: false,
      },
    ],
    risks: [],
    dependencies: [],
    estimatedTurns: 1,
    testStrategy: "Add tests.",
    rollbackPlan: "Revert the change.",
  };
  return {
    backendTurnId: `planning-turn-${suffix}`,
    status: "completed",
    output: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nReady to dispatch.`,
    summary: "Planning ready.",
  };
}

describe("Orchestrator planning fingerprint reuse", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-fingerprint-reuse-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "docs", "maverick", "epics"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_CONTEXT.md"),
      "# Maverick Context\n\nKeep planning bounded.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_MEMORY.md"),
      "# Project Memory\n\nInitial memory.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "epics", "control-plane.md"),
      "# Control Plane Epic\n\nLifecycle work.",
      "utf8",
    );

    initDatabase(join(tempDir, "orchestrator.db"));

    config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: { type: "mock", responseDelay: 0 },
      },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          workspaceKind: "notes",
          productionBranch: "main",
          epicBranches: [
            {
              id: "control-plane",
              branch: "control-plane",
              workstreamPrefix: "control-plane",
              charter: {
                summary: "Lifecycle work.",
                docs: [
                  {
                    path: "docs/maverick/PROJECT_CONTEXT.md",
                    purpose: "Project context.",
                  },
                  {
                    path: "docs/maverick/epics/control-plane.md",
                    purpose: "Epic context.",
                  },
                ],
              },
            },
          ],
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

  it("reuses stored plan when context fingerprint is unchanged and re-plans when memory changes", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      readyPlanningOutput("first"),
      readyPlanningOutput("second"),
    ]);

    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "fingerprint reuse",
      epicId: "control-plane",
    });

    const instruction = "Move planning forward and dispatch a slice.";

    // First call: should call Claude.
    const firstPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(firstPlan.needsAnswers).toBe(false);
    expect(firstPlan.finalExecutionPrompt).toContain("Implement the slice (first)");
    expect(utilityAdapter.turnRequests).toHaveLength(1);

    // Second call with no context changes: Claude should NOT be called.
    const reusedPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(utilityAdapter.turnRequests).toHaveLength(1);
    expect(reusedPlan.needsAnswers).toBe(false);
    expect(reusedPlan.finalExecutionPrompt).toContain("Implement the slice (first)");

    // Third call after modifying PROJECT_MEMORY.md: Claude IS called.
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_MEMORY.md"),
      "# Project Memory\n\nUpdated content that changes the fingerprint.",
      "utf8",
    );
    const replannedPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(utilityAdapter.turnRequests).toHaveLength(2);
    expect(replannedPlan.finalExecutionPrompt).toContain("Implement the slice (second)");
  });
});
