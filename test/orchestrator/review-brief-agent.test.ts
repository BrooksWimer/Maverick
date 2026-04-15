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
import { closeDatabase, initDatabase, workstreams } from "../../src/state/index.js";

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

describe("Orchestrator review and brief agent routing", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-review-brief-agent-"));
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
          claudeReview: {
            enabled: true,
            autoAfterTurn: false,
            model: "sonnet",
          },
        },
      ],
      brief: {
        enabled: true,
        storagePath: join(tempDir, "briefs"),
        model: "sonnet",
      },
    });
  });

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (error) {
        if (attempt === 9) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  });

  it("routes live Claude review and brief generation through the agent runner", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      agentOutput(
        {
          verdict: "needs-changes",
          severity: "major",
          passes: [
            { name: "Security", status: "clean", findingCount: 0 },
            { name: "Correctness", status: "findings", findingCount: 1 },
          ],
          securityFindings: [],
          architectureFindings: [],
          correctnessFindings: [
            {
              file: "src/orchestrator/orchestrator.ts",
              line: 640,
              severity: "error",
              category: "legacy-path",
              description: "The live review flow is still using the direct prompt builder.",
              suggestion: "Route it through the review agent.",
            },
          ],
          conventionFindings: [],
          suggestions: ["Route the live review path through src/agents."],
        },
        "Claude review complete.",
      ),
      agentOutput(
        {
          sections: [
            {
              projectId: "maverick",
              headline: "Review and brief now share the agent runner",
              delta: "The live review and brief paths route through src/agents while keeping src/claude as runtime support.",
              blockers: [],
              nextActions: ["Validate the broader chief-of-staff extension."],
            },
          ],
          criticalAlerts: [],
          velocityTrend: "steady",
          stuckWorkstreams: [],
          risksIdentified: ["Phase 3 still needs a broader orchestration extension."],
          recommendedActions: ["Implement the smallest stable Phase 3 slice."],
        },
        "Review and brief now share the agent runner.\n\nTop Priorities:\n- Implement the smallest stable Phase 3 slice.",
      ),
    ]);

    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "review routing",
    });
    workstreams.update(workstream.id, {
      planning_context_json: JSON.stringify({
        schemaVersion: 4,
        originalInstruction: "Route review through agents.",
        planningThreadId: "planning-thread",
        intake: null,
        goalFrame: null,
        modeling: {
          systemSummary: "Review relies on the orchestrator and stored planning context.",
          mermaid: "flowchart TD\n  A[Planning context] --> B[Review]",
          keyEntities: ["orchestrator", "planning context"],
          criticalFlows: ["review"],
          openQuestions: [],
        },
        testDesign: {
          strategySummary: "Review should confirm the planning regression tests still cover the stored path.",
          testCases: [
            {
              name: "Review context coverage",
              scope: "integration",
              purpose: "Ensures review sees stored planning artifacts.",
              files: ["test/orchestrator/review-brief-agent.test.ts"],
            },
          ],
          verificationChecklist: ["Run review/brief tests"],
          suggestedCommands: ["npx vitest run test/orchestrator/review-brief-agent.test.ts"],
        },
        feedbackRequest: null,
        explanation: null,
        result: {
          currentStateSummary: "Planning artifacts are stored.",
          recommendedNextSlice: "Run review.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "",
          rollbackPlan: "",
        },
        pendingQuestions: [],
        answers: {},
        finalExecutionPrompt: null,
        status: "needs-final-prompt",
        rawAgentOutput: "raw",
        createdAt: "2026-04-14T00:00:00.000Z",
        updatedAt: "2026-04-14T00:00:00.000Z",
      }),
    });

    const review = await orchestrator.review(workstream.id, "uncommitted", {
      reviewer: "claude",
      trigger: "manual",
    });

    expect(review.severity).toBe("major");
    expect(review.findings).toContain("legacy-path");
    expect(review.suggestions).toContain("Route the live review path through src/agents.");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Review Target");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("System Model");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Test Design");

    const brief = await orchestrator.generateBrief({
      trigger: "manual",
      requestedBy: "test",
      channelId: null,
    });

    expect(brief.content).toContain("Review and brief now share the agent runner.");
    expect(brief.markdown).toContain("Top Priorities");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Brief Context JSON");
  }, 15000);
});
