import { describe, expect, it } from "vitest";
import {
  buildPlanningContextRecord,
  mergePlanningAnswers,
  parsePlanningContextRecord,
  parsePlanningResult,
  renderPlanningSummary,
} from "../../src/agents/planning-support.js";

describe("parsePlanningResult", () => {
  it("normalizes decision-gated planning output", () => {
    const result = parsePlanningResult(
      {
        currentStateSummary: "Planning still uses direct Claude prompts.",
        recommendedNextSlice: "Route the live path through src/agents.",
        requiredAnswers: [
          {
            id: "discord-ux",
            question: "Should the fallback UX use a slash command?",
            whyItMatters: "The Discord answer flow changes operator instructions.",
            options: ["yes", "no"],
          },
        ],
        importantDecisions: [
          {
            question: "Should planning state live directly on workstreams?",
            whyItMatters: "It affects durability and reviewability.",
          },
        ],
        draftExecutionPrompt: "Implement Phase 1 using the stored planning context.",
        finalExecutionPrompt: "",
        remainingUnknowns: ["Whether native polls are worth it."],
        steps: [
          {
            order: 2,
            description: "Update Discord handling.",
            files: ["src/discord/bot.ts"],
            verification: "npm test",
            canParallelize: false,
          },
        ],
        risks: ["Stored context could drift if answer ids are unstable."],
        dependencies: ["Structured planning context must persist on the workstream."],
        estimatedTurns: 3,
        testStrategy: "Add targeted unit and integration tests.",
        rollbackPlan: "Revert the orchestration-facing planning changes.",
      },
      "",
    );

    expect(result.currentStateSummary).toContain("direct Claude prompts");
    expect(result.requiredAnswers[0]?.id).toBe("discord-ux");
    expect(result.importantDecisions[0]?.id).toBe("should-planning-state-live-directly-on-workstreams");
    expect(result.steps).toHaveLength(1);
    expect(result.estimatedTurns).toBe(3);
  });

  it("falls back gracefully when planning output is unstructured", () => {
    const result = parsePlanningResult(null, "Inspect src/orchestrator/orchestrator.ts and update the planning flow.");

    expect(result.currentStateSummary).toContain("unstructured output");
    expect(result.recommendedNextSlice).toContain("Review the raw planning output");
    expect(result.requiredAnswers).toEqual([]);
  });
});

describe("planning context records", () => {
  it("does not mark planning ready without a real final execution prompt", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Implement decision-gated planning.",
      rawAgentOutput: "raw",
      intake: {
        request: "Implement decision-gated planning.",
        scope: "Implement decision-gated planning.",
        outOfScope: "Broader orchestration redesign",
        acceptanceCriteria: ["Structured planning state persists"],
        risks: ["Resume flow could drift"],
        complexity: "medium",
        recommendation: "proceed",
        clarificationQuestions: [],
      },
      goalFrame: {
        objective: "Make planning durable.",
        problemStatement: "Planning cannot yet survive operator answer loops cleanly.",
        successCriteria: ["Stored final prompt is trustworthy"],
        constraints: ["Preserve existing behavior"],
        assumptions: ["Current repo state is the source of truth"],
        autonomyGuidance: "Keep work moving until a real decision gate appears.",
        operatorDecisionPolicy: "Escalate missing facts and high-ramification choices.",
      },
      result: parsePlanningResult(
        {
          currentStateSummary: "Planning analysis is complete.",
          recommendedNextSlice: "Review the draft prompt.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Draft prompt only.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Add tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    expect(context.status).toBe("needs-final-prompt");
    expect(context.finalExecutionPrompt).toBeNull();
    expect(renderPlanningSummary(context)).toContain("Structured intake");
    expect(renderPlanningSummary(context)).toContain("Goal frame");
    expect(renderPlanningSummary(context)).toContain("Draft Codex execution prompt");
  });

  it("marks the plan ready once all pending questions are answered", () => {
    const initial = buildPlanningContextRecord({
      originalInstruction: "Implement decision-gated planning.",
      rawAgentOutput: "raw",
      result: parsePlanningResult(
        {
          currentStateSummary: "Current planning is a one-shot blob.",
          recommendedNextSlice: "Persist structured context.",
          requiredAnswers: [
            {
              id: "answer-flow",
              question: "Should Discord use a slash command fallback?",
              whyItMatters: "The operator needs a durable way to answer questions.",
            },
          ],
          importantDecisions: [],
          draftExecutionPrompt: "Use slash-command answer capture.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Add tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    expect(initial.status).toBe("needs-answers");
    expect(initial.finalExecutionPrompt).toBeNull();

    const merged = mergePlanningAnswers(initial, { "answer-flow": "Yes, use /workstream answer-plan." }, {
      answeredBy: "user-1",
      answeredAt: "2026-04-14T21:00:00.000Z",
    });

    const resumed = buildPlanningContextRecord({
      originalInstruction: initial.originalInstruction,
      rawAgentOutput: "raw-2",
      previous: initial,
      answers: merged.mergedAnswers,
      result: parsePlanningResult(
        {
          currentStateSummary: "Slash command fallback is approved.",
          recommendedNextSlice: "Finalize the execution prompt.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Implement the answer-plan slash command and persist planning context.",
          finalExecutionPrompt: "Implement the answer-plan slash command and persist planning context.",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Add regression tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    expect(resumed.status).toBe("ready");
    expect(resumed.finalExecutionPrompt).toContain("answer-plan");
    expect(renderPlanningSummary(resumed)).toContain("Final Codex execution prompt");
    expect(parsePlanningContextRecord(JSON.stringify(resumed))?.answers["answer-flow"]?.answer).toContain("Yes");
  });

  it("round-trips stored intake and goal framing context", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Implement intake-aware planning.",
      rawAgentOutput: "raw",
      intake: {
        request: "Implement intake-aware planning.",
        scope: "Add intake and goal framing to planning.",
        outOfScope: "A full autonomous execution loop",
        acceptanceCriteria: ["Intake persists on the workstream"],
        risks: ["Planning context could diverge from intake"],
        complexity: "medium",
        recommendation: "proceed",
        clarificationQuestions: [],
      },
      goalFrame: {
        objective: "Add durable pre-planning layers.",
        problemStatement: "Planning should not start from raw operator text alone.",
        successCriteria: ["Goal frame is visible in stored planning summaries"],
        constraints: ["Use the existing src/agents layer"],
        assumptions: ["Resume should reuse stored framing"],
        autonomyGuidance: "Reuse the stored frame when answers arrive later.",
        operatorDecisionPolicy: "Escalate only missing facts or impactful design choices.",
      },
      modeling: {
        systemSummary: "Planning now has explicit pre-planning layers.",
        mermaid: "flowchart TD\n  A[Intake] --> B[Goal frame]\n  B --> C[Planning]",
        keyEntities: ["intake", "goal frame", "planning"],
        criticalFlows: ["fresh plan", "resume"],
        openQuestions: [],
      },
      testDesign: {
        strategySummary: "Test the planning context and resume path first.",
        testCases: [
          {
            name: "Planning context round-trip",
            scope: "integration",
            purpose: "Preserves the stored pre-planning layers.",
            files: ["test/agents/planning-support.test.ts"],
          },
        ],
        verificationChecklist: ["Run planning support tests"],
        suggestedCommands: ["npx vitest run test/agents/planning-support.test.ts"],
      },
      feedbackRequest: {
        headline: "Operator input needed",
        preface: "One short answer will unblock dispatch.",
        questions: [
          {
            questionId: "scope-choice",
            label: "Scope choice",
            prompt: "Keep this scoped to planning?",
            whyItMatters: "The next slice depends on whether broader scope is allowed.",
            options: ["Planning only", "Broader redesign"],
            recommendedOption: "Planning only",
          },
        ],
        answerInstructions: "Use /workstream answer-plan.",
        suggestedReplyFormat: "scope-choice: Planning only",
      },
      explanation: {
        headline: "Planning ready",
        summary: "The stored plan is ready to dispatch.",
        markdown: "## Planning Ready\nDispatch with the stored prompt.",
        nextAction: "Dispatch the workstream.",
      },
      result: parsePlanningResult(
        {
          currentStateSummary: "Intake and goal framing are persisted.",
          recommendedNextSlice: "Use them in planning.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Implement intake-aware planning.",
          finalExecutionPrompt: "Implement intake-aware planning.",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run planning tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    const parsed = parsePlanningContextRecord(JSON.stringify(context));

    expect(parsed?.schemaVersion).toBe(4);
    expect(parsed?.intake?.scope).toContain("goal framing");
    expect(parsed?.goalFrame?.objective).toContain("pre-planning");
    expect(parsed?.modeling?.keyEntities).toContain("goal frame");
    expect(parsed?.testDesign?.testCases[0]?.name).toContain("round-trip");
    expect(parsed?.feedbackRequest?.questions[0]?.questionId).toBe("scope-choice");
    expect(parsed?.explanation?.headline).toBe("Planning ready");
  });

  it("synthesizes pending questions from intake clarification questions when planning falls back", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Audit the repo and prepare a plan.",
      rawAgentOutput: [
        "Audit complete.",
        "",
        "Still needs your answers before executing the rest:",
        "1. Timing",
        "2. Replacement email",
      ].join("\n"),
      intake: {
        request: "Audit the repo and prepare a plan.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: [
          "What email address should replace bwimer@bu.edu?",
          "Do you want the quick-win fixes committed now or bundled with the larger content update?",
        ],
      },
      result: parsePlanningResult(null, "Unstructured planning summary."),
    });

    expect(context.status).toBe("needs-answers");
    expect(context.pendingQuestions).toHaveLength(2);
    expect(context.feedbackRequest?.questions).toHaveLength(2);
    expect(context.feedbackRequest?.suggestedReplyFormat).toContain("clarification-1:");
  });

  it("re-hydrates synthesized pending questions when stored context had none persisted", () => {
    const stored = JSON.stringify({
      schemaVersion: 4,
      originalInstruction: "Audit the repo and prepare a plan.",
      intake: {
        request: "Audit the repo and prepare a plan.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: [
          "What email address should replace bwimer@bu.edu?",
        ],
      },
      result: {
        currentStateSummary: "Planning returned unstructured output. Review the stored raw plan text before dispatch.",
        recommendedNextSlice: "Review the raw planning output and answer any pending planning questions before dispatch.",
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
      rawAgentOutput: "Audit complete.",
      createdAt: "2026-04-25T21:16:19.000Z",
      updatedAt: "2026-04-25T21:53:30.000Z",
    });

    const parsed = parsePlanningContextRecord(stored);

    expect(parsed?.pendingQuestions).toHaveLength(1);
    expect(parsed?.feedbackRequest?.questions[0]?.questionId).toBe("clarification-1");
    expect(parsed?.status).toBe("needs-answers");
  });

  it("includes the full raw planning output and skips empty structured sections on fallback", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Audit the repo and prepare a plan.",
      rawAgentOutput: "Full freeform planning output.\n- Stale bio\n- Dead email",
      intake: {
        request: "Audit the repo and prepare a plan.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: ["What email address should replace bwimer@bu.edu?"],
      },
      result: parsePlanningResult(null, "Full freeform planning output.\n- Stale bio\n- Dead email"),
    });

    const rendered = renderPlanningSummary(context);

    expect(rendered).toContain("Raw planning output:");
    expect(rendered).toContain("Full freeform planning output.");
    expect(rendered).not.toContain("Implementation steps:");
    expect(rendered).not.toContain("Risks:\nNone recorded.");
  });
});
