import { describe, expect, it } from "vitest";
import {
  buildPlanningContextRecord,
  mergePlanningAnswers,
  parsePlanningContextRecord,
  parsePlanningResult,
  renderPlanningSummary,
  structureRawPlanningOutput,
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

  it("structures a prose plan from a repo-owned ready dispatch prompt without another agent run", () => {
    const rawAgentOutput = [
      "**Maverick is ready to dispatch.**",
      "",
      "The plan is grounded in the actual `index.html` and the durable planning baseline.",
      "",
      "If those defaults are acceptable, Codex can be dispatched immediately with the `finalExecutionPrompt` above.",
    ].join("\n");
    const durablePlanDoc = [
      "# Making Portfolio Pop",
      "",
      "## Main Files",
      "",
      "- `index.html`: hero and project cards.",
      "- `assets/css/main.css`: compiled site CSS.",
      "",
      "## Constraints",
      "",
      "- Do not add new site dependencies.",
      "- Do not invent facts.",
      "",
      "## Verification Checklist",
      "",
      "- Serve the site locally.",
      "- Check desktop and mobile viewports.",
      "",
      "## Ready Dispatch Prompt",
      "",
      "```text",
      "Implement a portfolio polish pass for this static HTML/CSS portfolio.",
      "",
      "Implement the work in slices:",
      "1. Hero positioning and anchor navigation.",
      "2. Project card hooks and title cleanup.",
      "3. Mobile and accessibility fixes.",
      "```",
    ].join("\n");

    const result = structureRawPlanningOutput({
      originalInstruction: "Create a bounded implementation plan.",
      rawAgentOutput,
      supplementalDocs: [durablePlanDoc],
    });

    expect(result?.finalExecutionPrompt).toContain("Implement a portfolio polish pass");
    expect(result?.steps.map((step) => step.description)).toContain("Hero positioning and anchor navigation.");
    expect(result?.steps[0]?.files).toContain("index.html");
    expect(result?.testStrategy).toContain("Serve the site locally");
    expect(result?.risks).toContain("Do not invent facts.");
  });

  it("extracts structured planning JSON from a fenced raw Claude response", () => {
    const result = parsePlanningResult(
      null,
      [
        "The plan is ready.",
        "```json",
        JSON.stringify({
          currentStateSummary: "Portfolio plan is almost ready.",
          recommendedNextSlice: "Answer the two remaining decisions.",
          requiredAnswers: [
            {
              id: "syncsonic-intent",
              question: "Update the existing SyncSonic page or create a new one?",
              whyItMatters: "The page shape changes.",
            },
          ],
          importantDecisions: [
            {
              id: "repo-read-access",
              question: "Grant read access to related repos?",
              whyItMatters: "Project copy needs repo research.",
            },
          ],
          draftExecutionPrompt: "Update the portfolio.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 2,
          testStrategy: "Open the static site.",
          rollbackPlan: "git revert HEAD",
        }),
        "```",
      ].join("\n"),
    );

    expect(result.currentStateSummary).toContain("almost ready");
    expect(result.requiredAnswers[0]?.id).toBe("syncsonic-intent");
    expect(result.importantDecisions[0]?.id).toBe("repo-read-access");
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

  it("round-trips stored intake context", () => {
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

    expect(parsed?.schemaVersion).toBe(5);
    expect(parsed?.intake?.scope).toContain("goal framing");
    expect(parsed?.result.currentStateSummary).toContain("Intake and goal framing are persisted");
    expect(parsed?.pendingQuestions).toEqual([]);
    expect(parsed?.status).toBe("ready");
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
    expect(context.pendingQuestions.map((question) => question.id)).toEqual(["clarification-1", "clarification-2"]);
  });

  it("uses intake clarification questions when fallback planning has no structured questions", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Audit the portfolio and prepare update questions.",
      rawAgentOutput: "Unstructured portfolio planning summary.",
      intake: {
        request: "Audit the portfolio and prepare update questions.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: [
          "What new job and project content should be added?",
          "Should quick wins be bundled or committed separately?",
        ],
      },
      result: parsePlanningResult(null, "Unstructured portfolio planning summary."),
    });

    expect(context.pendingQuestions.map((question) => question.id)).toEqual([
      "clarification-1",
      "clarification-2",
    ]);
  });

  it("does not preserve stale persisted questions when building fallback context", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Audit the portfolio and prepare update questions.",
      rawAgentOutput: "Unstructured portfolio planning summary.",
      intake: {
        request: "Audit the portfolio and prepare update questions.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: [
          "What new projects should be added?",
          "Should the resume PDF be replaced?",
        ],
      },
      result: parsePlanningResult(null, "Unstructured portfolio planning summary."),
    });

    expect(context.pendingQuestions.map((question) => question.id)).toEqual([
      "clarification-1",
      "clarification-2",
    ]);
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
    expect(parsed?.pendingQuestions[0]?.id).toBe("clarification-1");
    expect(parsed?.status).toBe("needs-answers");
  });

  it("keeps persisted fallback questions when re-hydrating stored context", () => {
    const stored = JSON.stringify({
      schemaVersion: 4,
      originalInstruction: "Audit the portfolio and prepare a plan.",
      intake: {
        request: "Audit the portfolio and prepare a plan.",
        scope: "Audit first, then plan updates.",
        outOfScope: "",
        acceptanceCriteria: [],
        risks: [],
        complexity: "large",
        recommendation: "needs-clarification",
        clarificationQuestions: ["What new projects should be added?"],
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
      pendingQuestions: [
        {
          id: "clarification-1",
          question: "What new projects should be added?",
          whyItMatters: "Old broad question.",
          options: [],
          kind: "required-answer",
        },
      ],
      rawAgentOutput: "Audit complete.",
    });

    const parsed = parsePlanningContextRecord(stored);

    expect(parsed?.pendingQuestions.map((question) => question.id)).toEqual([
      "clarification-1",
    ]);
  });

  it("re-hydrates structured questions from stored raw JSON and filters already answered questions", () => {
    const rawAgentOutput = [
      "Plan follows.",
      "```json",
      JSON.stringify({
        currentStateSummary: "Portfolio plan is almost ready.",
        recommendedNextSlice: "Answer remaining decisions.",
        requiredAnswers: [
          {
            id: "syncsonic-intent",
            question: "Update the existing SyncSonic page or create a new one?",
            whyItMatters: "The page shape changes.",
          },
        ],
        importantDecisions: [
          {
            id: "repo-read-access",
            question: "Grant read access to related repos?",
            whyItMatters: "Project copy needs repo research.",
          },
        ],
        draftExecutionPrompt: "Update the portfolio.",
        finalExecutionPrompt: "",
        remainingUnknowns: [],
        steps: [],
        risks: [],
        dependencies: [],
        estimatedTurns: 2,
        testStrategy: "Open the static site.",
        rollbackPlan: "git revert HEAD",
      }),
      "```",
    ].join("\n");
    const stored = JSON.stringify({
      schemaVersion: 4,
      originalInstruction: "Update the portfolio.",
      rawAgentOutput,
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
      answers: {
        "syncsonic-intent": {
          questionId: "syncsonic-intent",
          answer: "Update the existing page.",
          answeredAt: "2026-04-26T00:00:00.000Z",
          answeredBy: "operator",
        },
      },
    });

    const parsed = parsePlanningContextRecord(stored);

    expect(parsed?.result.currentStateSummary).toContain("almost ready");
    expect(parsed?.pendingQuestions.map((question) => question.id)).toEqual(["repo-read-access"]);
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

  it("can render an answer-focused planning summary without stale agent transcript sections", () => {
    const context = buildPlanningContextRecord({
      originalInstruction: "Audit the repo and prepare a plan.",
      rawAgentOutput: "Before approving, answer old-question-1.",
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
      result: parsePlanningResult(null, "Before approving, answer old-question-1."),
    });

    const rendered = renderPlanningSummary(context, {
      includeAgentSections: false,
      includeRawOutput: false,
    });

    expect(rendered).toContain("Pending planning questions:");
    expect(rendered).toContain("clarification-1");
    expect(rendered).not.toContain("Operator feedback request:");
    expect(rendered).not.toContain("Discord explanation:");
    expect(rendered).not.toContain("Raw planning output:");
    expect(rendered).not.toContain("clarification-2");
  });
});
