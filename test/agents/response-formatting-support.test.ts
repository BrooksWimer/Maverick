import { describe, expect, it } from "vitest";
import { coerceExplanationResult } from "../../src/agents/response-formatting-support.js";
import { buildPlanningContextRecord, parsePlanningResult } from "../../src/agents/planning-support.js";

describe("response formatting support", () => {
  it("falls back to a questionnaire-based explanation when planning still needs answers", () => {
    const planningContext = buildPlanningContextRecord({
      originalInstruction: "Improve planning feedback.",
      rawAgentOutput: "raw",
      feedbackRequest: {
        headline: "Need one answer",
        preface: "One answer remains before dispatch.",
        questions: [
          {
            questionId: "discord-ux",
            label: "Discord answer path",
            prompt: "Use the slash command fallback?",
            whyItMatters: "The answer capture path affects the operator UX.",
            options: ["/workstream answer-plan"],
            recommendedOption: "/workstream answer-plan",
          },
        ],
        answerInstructions: "Use /workstream answer-plan.",
        suggestedReplyFormat: "discord-ux: /workstream answer-plan",
      },
      result: parsePlanningResult(
        {
          currentStateSummary: "Planning is waiting on one operator decision.",
          recommendedNextSlice: "Resolve the answer path and continue.",
          requiredAnswers: [
            {
              id: "discord-ux",
              question: "Use the slash command fallback?",
              whyItMatters: "The answer path affects the operator UX.",
            },
          ],
          importantDecisions: [],
          draftExecutionPrompt: "Draft prompt.",
          finalExecutionPrompt: "",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    const explanation = coerceExplanationResult(null, planningContext, planningContext.feedbackRequest);

    expect(explanation.headline).toContain("waiting on operator input");
    expect(explanation.markdown).toContain("discord-ux");
  });

  it("normalizes structured Discord markdown when the formatter agent returns it", () => {
    const planningContext = buildPlanningContextRecord({
      originalInstruction: "Improve planning feedback.",
      rawAgentOutput: "raw",
      result: parsePlanningResult(
        {
          currentStateSummary: "Planning is ready.",
          recommendedNextSlice: "Dispatch the stored prompt.",
          requiredAnswers: [],
          importantDecisions: [],
          draftExecutionPrompt: "Final prompt.",
          finalExecutionPrompt: "Final prompt.",
          remainingUnknowns: [],
          steps: [],
          risks: [],
          dependencies: [],
          estimatedTurns: 1,
          testStrategy: "Run tests.",
          rollbackPlan: "Revert.",
        },
        "",
      ),
    });

    const explanation = coerceExplanationResult(
      {
        headline: "Ready",
        summary: "Dispatch can proceed.",
        markdown: "## Ready\nDispatch now.",
        nextAction: "Dispatch it.",
      },
      planningContext,
      null,
    );

    expect(explanation.markdown).toContain("Dispatch now");
    expect(explanation.nextAction).toBe("Dispatch it.");
  });
});
