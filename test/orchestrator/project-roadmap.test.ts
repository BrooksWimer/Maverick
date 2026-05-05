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

  constructor(name: string, private readonly turnResults: TurnResult[]) {
    this.name = name;
  }

  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> { this.threads.clear(); }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread = { id: `${this.name}-thread-${this.nextThreadId++}`, cwd, status: "idle" as const };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    this.turnRequests.push(request);
    const result = this.turnResults.shift();
    if (!result) throw new Error(`No queued turn result for ${this.name}`);
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
    currentStateSummary: `State ${suffix}`,
    recommendedNextSlice: `Slice ${suffix}`,
    roadmapMilestone: "Milestone A",
    requiredAnswers: [],
    importantDecisions: [],
    draftExecutionPrompt: `Draft ${suffix}`,
    finalExecutionPrompt: `Final ${suffix}`,
    remainingUnknowns: [],
    steps: [{ order: 1, description: "Do thing", files: ["src/x.ts"], verification: "npm test", canParallelize: false }],
    risks: [],
    dependencies: [],
    estimatedTurns: 1,
    testStrategy: "tests",
    rollbackPlan: "revert",
  };
  return {
    backendTurnId: `t-${suffix}`,
    status: "completed",
    output: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\nReady.`,
    summary: "Ready.",
  };
}

describe("Orchestrator project roadmap context", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-roadmap-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "docs", "maverick", "epics"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_CONTEXT.md"),
      "# context\n\nSome context.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_MEMORY.md"),
      "# memory\n\nSome memory.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "epics", "control-plane.md"),
      "# epic\n\nWork.",
      "utf8",
    );

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
          epicBranches: [
            {
              id: "control-plane",
              branch: "control-plane",
              workstreamPrefix: "control-plane",
              charter: {
                summary: "Lifecycle work.",
                docs: [{ path: "docs/maverick/epics/control-plane.md", purpose: "Epic context." }],
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

  it("reads PROJECT_ROADMAP.md into the planning bundle", async () => {
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_ROADMAP.md"),
      "# Roadmap\n\n## Milestone A\n\nShip the autonomous lifecycle.",
      "utf8",
    );

    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const utility = new QueuedAdapter("utility", [readyPlanningOutput("first")]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utility;

    const ws = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "roadmap reader",
      epicId: "control-plane",
    });

    const plan = await orchestrator.generatePlan(ws.id, "Plan a slice toward the milestone.", "manual");
    expect(plan.planningContext.contextBundle?.roadmap).toContain("Milestone A");
    expect(plan.planningContext.contextBundle?.roadmap).toContain("Ship the autonomous lifecycle");
    expect(plan.planningContext.contextBundle?.roadmapPath).toContain("PROJECT_ROADMAP.md");
    expect(utility.turnRequests[0]?.instruction).toContain("Project Roadmap");
    expect(utility.turnRequests[0]?.instruction).toContain("Milestone A");
  });

  it("invalidates the fingerprint when roadmap content changes", async () => {
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_ROADMAP.md"),
      "# Roadmap\n\nInitial roadmap content.",
      "utf8",
    );

    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const utility = new QueuedAdapter("utility", [
      readyPlanningOutput("first"),
      readyPlanningOutput("second"),
    ]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utility;

    const ws = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "roadmap fingerprint",
      epicId: "control-plane",
    });

    const first = await orchestrator.generatePlan(ws.id, "Plan it.", "manual");
    expect(first.finalExecutionPrompt).toContain("Final first");
    expect(utility.turnRequests).toHaveLength(1);

    // Same context: should reuse, no second Claude call.
    await orchestrator.generatePlan(ws.id, "Plan it.", "manual");
    expect(utility.turnRequests).toHaveLength(1);

    // Modify the roadmap: fingerprint changes, Claude is called again.
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_ROADMAP.md"),
      "# Roadmap\n\nUpdated roadmap content.",
      "utf8",
    );
    const replanned = await orchestrator.generatePlan(ws.id, "Plan it.", "manual");
    expect(utility.turnRequests).toHaveLength(2);
    expect(replanned.finalExecutionPrompt).toContain("Final second");
  });

  it("falls back to a default message when the roadmap is absent", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const utility = new QueuedAdapter("utility", [readyPlanningOutput("first")]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utility;

    const ws = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "no roadmap",
      epicId: "control-plane",
    });

    const plan = await orchestrator.generatePlan(ws.id, "Plan it.", "manual");
    expect(plan.planningContext.contextBundle?.roadmapPath).toBeNull();
    expect(plan.planningContext.contextBundle?.roadmap).toContain("No PROJECT_ROADMAP.md");
  });
});
