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
  readonly turnRequests: TurnRequest[] = [];
  private readonly threads = new Map<string, ExecutionThread>();
  private nextThreadId = 1;

  constructor(
    readonly name: string,
    private readonly turnResults: TurnResult[],
  ) {}

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
    return {
      findings: "clean",
      severity: "clean",
      suggestions: [],
    };
  }

  onOutput(_callback: (threadId: string, content: string, isPartial: boolean) => void): void {}

  onApprovalRequest(_callback: (threadId: string, request: ApprovalRequest) => void): void {}
}

function agentOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return {
    backendTurnId: "agent-turn",
    status: "completed",
    output: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${summary}`,
    summary,
  };
}

const planningRouting = {
  profiles: {
    cheap: "haiku",
    default: "sonnet",
    deep: "sonnet",
  },
  agents: {
    intake: "cheap",
    goalFraming: "cheap",
    modeling: "default",
    testDesign: "cheap",
    planning: "deep",
    operatorFeedback: "cheap",
    responseFormatting: "cheap",
    epicContext: "default",
  },
} as const;

describe("Orchestrator epic-context agent integration", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-epic-context-agent-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");
    mkdirSync(join(repoPath, "docs", "maverick", "epics"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_CONTEXT.md"),
      "# Astra Context\n\nAstra turns local network facts into ordinary-user insight.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "epics", "router-admin-ingestion.md"),
      "# Router Admin Ingestion\n\nDo not overfit to Xfinity-only selectors.",
      "utf8",
    );

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
          claudePlanning: {
            enabled: true,
            autoOnPlanningState: false,
            model: "sonnet",
          },
          epicBranches: [
            {
              id: "router-admin-ingestion",
              branch: "codex/router-admin-ingestion",
              charter: {
                summary: "Router admin ingestion is a real product capability.",
                bullets: ["Prefer durable router-vendor generalization."],
                docs: [
                  {
                    path: "docs/maverick/PROJECT_CONTEXT.md",
                    purpose: "Project context.",
                  },
                  {
                    path: "docs/maverick/epics/router-admin-ingestion.md",
                    purpose: "Epic context.",
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
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("feeds bounded repo-owned epic context into the planning agent", async () => {
    config.projects[0]!.claudePlanning!.routing = planningRouting;
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      agentOutput(
        {
          request: "Plan the next router-admin ingestion slice.",
          scope: "Plan the next router-admin ingestion slice without overfitting to one vendor.",
          outOfScope: "Rebuilding the entire router-admin stack.",
          acceptanceCriteria: ["The next slice respects the epic charter boundary."],
          risks: ["Vendor-specific selectors could leak into shared abstractions."],
          complexity: "medium",
          recommendation: "proceed",
          clarificationQuestions: [],
        },
        "Intake ready.",
      ),
      agentOutput(
        {
          systemSummary: "The router-admin ingestion flow spans epic context, planning, and downstream implementation.",
          mermaid: "flowchart TD\n  A[Epic context] --> B[Planning]\n  B --> C[Router-admin slice]",
          keyEntities: ["epic context", "planning", "router-admin slice"],
          criticalFlows: ["planning"],
          openQuestions: [],
        },
        "Model ready.",
      ),
      agentOutput(
        {
          currentStateSummary: "Planning has dynamic epic context available.",
          recommendedNextSlice: "Use the epic context summary while shaping the next implementation slice.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Implement the next router-admin slice without overfitting to one vendor UI.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Add focused tests.",
          rollbackPlan: "Revert.",
        },
        "Planning ready.",
      ),
    ]);

    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;

    const workstream = await orchestrator.createWorkstream({
      projectId: "netwise",
      name: "router admin capture",
      epicId: "router-admin-ingestion",
    });

    await orchestrator.generatePlan(
      workstream.id,
      "Plan the next router-admin ingestion slice.",
      "manual",
    );

    expect(utilityAdapter.turnRequests).toHaveLength(3);
    expect(utilityAdapter.turnRequests[0]?.model).toBe("haiku");
    expect(utilityAdapter.turnRequests[1]?.model).toBe("sonnet");
    expect(utilityAdapter.turnRequests[2]?.model).toBe("sonnet");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Bounded Epic Context");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Do not overfit to Xfinity-only selectors.");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Epic Context Analysis");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Do not overfit to Xfinity-only selectors.");
  });
});
