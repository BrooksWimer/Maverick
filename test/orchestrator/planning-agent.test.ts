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
import { artifacts, closeDatabase, initDatabase } from "../../src/state/index.js";

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
    return {
      findings: "clean",
      severity: "clean",
      suggestions: [],
    };
  }

  onOutput(_callback: (threadId: string, content: string, isPartial: boolean) => void): void {}

  onApprovalRequest(_callback: (threadId: string, request: ApprovalRequest) => void): void {}
}

function planningOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return {
    backendTurnId: "planning-turn",
    status: "completed",
    output: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${summary}`,
    summary,
  };
}

function intakeOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
}

function goalFrameOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
}

function feedbackOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
}

function formattingOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
}

function modelingOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
}

function testDesignOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return planningOutput(payload, summary);
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

describe("Orchestrator planning agent flow", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-planning-agent-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");
    mkdirSync(join(repoPath, "src"), { recursive: true });
    mkdirSync(join(repoPath, "docs", "maverick", "epics"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "maverick", "PROJECT_CONTEXT.md"),
      "# Maverick Context\n\nKeep planning bounded and durable.",
      "utf8",
    );
    writeFileSync(
      join(repoPath, "docs", "maverick", "epics", "control-plane.md"),
      "# Control Plane Epic\n\nPlanning cost and lifecycle work belongs here.",
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
                summary: "Planning and orchestration lifecycle work.",
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
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
          claudePlanning: {
            enabled: true,
            autoOnPlanningState: false,
            model: "sonnet",
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

  it("stores planning context, resumes with answers, and dispatches the final prompt", async () => {
    config.projects[0]!.claudePlanning!.routing = planningRouting;
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const instruction = "Implement the corrected decision-gated planning migration.";

    const utilityAdapter = new QueuedAdapter("utility", [
      intakeOutput(
        {
          request: instruction,
          scope: "Move live planning onto the existing src/agents path with durable decision gates.",
          outOfScope: "Rebuilding src/agents from scratch.",
          acceptanceCriteria: ["Planning context persists structurally."],
          risks: ["Answer ids must remain stable across replanning."],
          complexity: "medium",
          recommendation: "proceed",
          clarificationQuestions: [],
        },
        "Intake is scoped.",
      ),
      modelingOutput(
        {
          systemSummary: "Planning depends on the orchestration layer, persisted workstream state, and Discord operator handoff.",
          mermaid:
            "flowchart TD\n  A[Operator instruction] --> B[Intake]\n  B --> C[Goal frame]\n  C --> D[Planning context]\n  D --> E[Discord follow-up]",
          keyEntities: ["orchestrator", "planning_context_json", "discord bot"],
          criticalFlows: ["Plan generation", "Answer resume"],
          openQuestions: [],
        },
        "Model is ready.",
      ),
      planningOutput(
        {
          currentStateSummary: "Live planning still bypasses src/agents.",
          recommendedNextSlice: "Move planning onto the existing planning agent and persist structured state.",
          requiredAnswers: [
            {
              id: "discord-ux",
              question: "Should the fallback Discord flow use /workstream answer-plan?",
              whyItMatters: "The operator answer loop needs a durable input path.",
            },
          ],
          importantDecisions: [],
          draftExecutionPrompt: "Pending operator answers before final dispatch prompt.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [
            {
              order: 1,
              description: "Persist structured planning context on workstreams.",
              files: ["src/state/schema.sql", "src/state/repositories.ts"],
              verification: "npm test -- planning",
              canParallelize: false,
            },
          ],
          risks: ["Pending answers must survive replanning."],
          dependencies: ["Existing src/agents baseline must be wired into the live path."],
          estimatedTurns: 2,
          testStrategy: "Add helper and orchestrator tests.",
          rollbackPlan: "Revert the planning-specific schema and orchestrator changes.",
        },
        "Planning needs one operator answer.",
      ),
      modelingOutput(
        {
          systemSummary: "Planning model updated only from the operator answer checkpoint.",
          mermaid: "flowchart TD\n  A[Stored context] --> B[Answered decision]\n  B --> C[Final plan]",
          keyEntities: ["planning_context_json", "operator answers"],
          criticalFlows: ["Answer resume"],
          openQuestions: [],
        },
        "Model update is bounded to answers.",
      ),
      planningOutput(
        {
          currentStateSummary: "The slash-command fallback was approved.",
          recommendedNextSlice: "Finalize the Codex execution prompt and keep the stored summary in sync.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt:
            "Implement the decision-gated planning migration using the stored planning context and the /workstream answer-plan fallback.",
          finalExecutionPrompt:
            "Implement the decision-gated planning migration using the stored planning context and the /workstream answer-plan fallback.",
          remainingUnknowns: [],
          steps: [
            {
              order: 1,
              description: "Implement the answer-plan command and resume flow.",
              files: ["src/discord/bot.ts", "src/orchestrator/orchestrator.ts"],
              verification: "npm test -- planning-agent",
              canParallelize: false,
            },
          ],
          risks: ["Dispatch must use the stored final prompt only for the matching instruction."],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run unit and integration coverage for planning resume.",
          rollbackPlan: "Revert the answer-plan and stored prompt changes.",
        },
        "Planning is ready to dispatch.",
      ),
    ]);
    const dispatchAdapter = new QueuedAdapter("dispatch", [
      {
        backendTurnId: "dispatch-turn",
        status: "completed",
        output: "executed",
        summary: "executed",
      },
    ]);

    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;
    (orchestrator as { adapters: Map<string, ExecutionBackendAdapter> }).adapters.set("maverick", dispatchAdapter);

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "planning migration",
      epicId: "control-plane",
    });

    const initialPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(initialPlan.needsAnswers).toBe(true);
    expect(initialPlan.planningContext.pendingQuestions).toHaveLength(1);
    expect(initialPlan.planningContext.intake?.scope).toContain("decision gates");
    expect(initialPlan.planningContext.goalFrame?.objective).toContain("decision gates");
    expect(initialPlan.planningContext.modeling?.keyEntities).toContain("orchestrator");
    expect(initialPlan.planningContext.testDesign?.testCases[0]?.name).toBe("Acceptance criterion 1");
    expect(initialPlan.planningContext.feedbackRequest?.questions).toHaveLength(1);
    expect(initialPlan.planningContext.explanation?.markdown).toContain("Operator input needed");
    expect(initialPlan.planningContext.contextBundle?.projectContext).toContain("bounded");
    expect(initialPlan.planningContext.contextBundle?.epicContext).toContain("Planning cost");

    const storedAfterInitial = orchestrator.getWorkstream(workstream.id);
    expect(storedAfterInitial?.state).toBe("awaiting-decisions");
    expect(storedAfterInitial?.pending_decision).toContain("discord-ux");
    expect(storedAfterInitial?.planning_context_json).toContain("discord-ux");
    expect(storedAfterInitial?.planning_context_json).toContain("\"goalFrame\"");
    expect(storedAfterInitial?.plan).toContain("Pending planning questions");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.health).toBe("awaiting-input");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.latestReport?.kind).toBe("plan");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.nextAction).toContain("Answer the pending planning questions");
    await expect(orchestrator.dispatch(workstream.id, instruction)).rejects.toThrow("planning still has unresolved questions");

    const resumedPlan = await orchestrator.provideDecisionAnswers(
      workstream.id,
      { "discord-ux": "Yes. Use /workstream answer-plan as the fallback." },
      "discord-user",
    );

    expect(resumedPlan.needsAnswers).toBe(false);
    expect(resumedPlan.finalExecutionPrompt).toContain("/workstream answer-plan");

    const storedAfterResume = orchestrator.getWorkstream(workstream.id);
    expect(storedAfterResume?.state).toBe("planning");
    expect(storedAfterResume?.pending_decision).toBeNull();
    expect(storedAfterResume?.plan).toContain("Final Codex execution prompt");
    expect(storedAfterResume?.planning_context_json).toContain("discord-user");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.latestReport?.kind).toBe("plan");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.nextAction).toContain("Dispatch the next implementation step");

    await orchestrator.dispatch(workstream.id, instruction);
    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("implementation");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.latestReport?.kind).toBe("dispatch");
    expect(orchestrator.getWorkstreamStatusSnapshot(workstream.id)?.nextAction).toContain("Verify the changes before moving to review");
    expect(artifacts.listByWorkstream(workstream.id).filter((artifact) => artifact.type === "operator-report")).toHaveLength(3);

    expect(dispatchAdapter.turnRequests[0]?.instruction).toContain("Execution workspace rules:");
    expect(dispatchAdapter.turnRequests[0]?.instruction).toContain(resumedPlan.finalExecutionPrompt ?? "");
    expect(utilityAdapter.turnRequests).toHaveLength(5);
    expect(utilityAdapter.turnRequests[0]?.model).toBe("haiku");
    expect(utilityAdapter.turnRequests[1]?.model).toBe("sonnet");
    expect(utilityAdapter.turnRequests[2]?.model).toBe("sonnet");
    expect(utilityAdapter.turnRequests[3]?.model).toBe("sonnet");
    expect(utilityAdapter.turnRequests[4]?.model).toBe("sonnet");
    for (const request of utilityAdapter.turnRequests) {
      expect(request.noSessionPersistence).toBe(true);
      expect(request.maxBudgetUsd).toBeGreaterThan(0);
      expect(request.jsonSchema).toEqual({ type: "object" });
      expect(request.disallowedTools).toContain("WebSearch");
    }
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Bounded Project Context");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Changed Evidence");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Previous System Model");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Changed Evidence");
    expect(utilityAdapter.turnRequests[3]?.instruction).toContain("Previous System Model");
    expect(utilityAdapter.turnRequests[3]?.instruction).toContain("Changed Evidence");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Structured Intake");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Goal Frame");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("System Model");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Test Design");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Context Fingerprint");
    expect(utilityAdapter.turnRequests[2]?.instruction).toContain("Broader Inspection Policy");
    expect(utilityAdapter.turnRequests[4]?.threadId).toBe(utilityAdapter.turnRequests[2]?.threadId);
    expect(utilityAdapter.turnRequests[4]?.instruction).toContain("Resume the stored planning flow");
    expect(utilityAdapter.turnRequests[4]?.instruction).toContain("Yes. Use /workstream answer-plan as the fallback.");
  });

  it("starts a fresh planning flow by default and only reuses the thread when resume is explicit", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      intakeOutput(
        {
          request: "Plan the next migration slice.",
          scope: "Capture a fresh plan.",
          outOfScope: "",
          acceptanceCriteria: ["A fresh planning context exists."],
          risks: [],
          complexity: "small",
          recommendation: "proceed",
          clarificationQuestions: [],
        },
        "First intake.",
      ),
      modelingOutput(
        {
          systemSummary: "First plan model.",
          mermaid: "flowchart TD\n  A[First] --> B[Plan]",
          keyEntities: ["planner"],
          criticalFlows: ["fresh plan"],
          openQuestions: [],
        },
        "First model.",
      ),
      planningOutput(
        {
          currentStateSummary: "Fresh plan one.",
          recommendedNextSlice: "Capture the first draft.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Draft one.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run tests.",
          rollbackPlan: "Revert.",
        },
        "First draft only.",
      ),
      intakeOutput(
        {
          request: "Plan the next migration slice.",
          scope: "Capture a second fresh plan.",
          outOfScope: "",
          acceptanceCriteria: ["A second planning context exists."],
          risks: [],
          complexity: "small",
          recommendation: "proceed",
          clarificationQuestions: [],
        },
        "Second intake.",
      ),
      modelingOutput(
        {
          systemSummary: "Second plan model.",
          mermaid: "flowchart TD\n  A[Second] --> B[Plan]",
          keyEntities: ["planner"],
          criticalFlows: ["fresh plan"],
          openQuestions: [],
        },
        "Second model.",
      ),
      planningOutput(
        {
          currentStateSummary: "Fresh plan two.",
          recommendedNextSlice: "Start over cleanly.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Draft two.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run tests.",
          rollbackPlan: "Revert.",
        },
        "Second fresh draft.",
      ),
      planningOutput(
        {
          currentStateSummary: "Resumed plan.",
          recommendedNextSlice: "Finalize after explicit resume.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Final draft.",
          finalExecutionPrompt: "Final dispatch prompt.",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run tests.",
          rollbackPlan: "Revert.",
        },
        "Ready after explicit resume.",
      ),
    ]);

    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "fresh vs resume",
      epicId: "control-plane",
    });
    const instruction = "Plan the next migration slice.";

    const firstPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("planning");
    const secondPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual");
    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("planning");
    const resumedPlan = await orchestrator.generatePlan(workstream.id, instruction, "manual", {
      resumeExisting: true,
    });

    expect(firstPlan.finalExecutionPrompt).toBeNull();
    expect(secondPlan.finalExecutionPrompt).toBeNull();
    expect(resumedPlan.finalExecutionPrompt).toBe("Final dispatch prompt.");
    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("planning");
    expect(utilityAdapter.turnRequests).toHaveLength(7);
    expect(utilityAdapter.turnRequests[2]?.threadId).not.toBe(utilityAdapter.turnRequests[5]?.threadId);
    expect(utilityAdapter.turnRequests[5]?.instruction).not.toContain("Resume the stored planning flow");
    expect(utilityAdapter.turnRequests[6]?.threadId).toBe(utilityAdapter.turnRequests[5]?.threadId);
    expect(utilityAdapter.turnRequests[6]?.instruction).toContain("Resume the stored planning flow");
    expect(new Set(utilityAdapter.turnRequests.map((request) => request.model))).toEqual(new Set(["sonnet"]));
  });
});
