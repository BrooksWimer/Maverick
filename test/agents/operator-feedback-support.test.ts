import { describe, expect, it } from "vitest";
import {
  coerceOperatorFeedbackResult,
  renderOperatorFeedbackMarkdown,
} from "../../src/agents/operator-feedback-support.js";

describe("operator feedback support", () => {
  const pendingQuestions = [
    {
      id: "discord-ux",
      kind: "required-answer" as const,
      question: "Should Discord use the slash-command fallback?",
      whyItMatters: "The answer path affects the operator workflow.",
      options: ["/workstream answer-plan", "something else"],
    },
  ];

  it("falls back to the planning questions when the agent returns no structure", () => {
    const result = coerceOperatorFeedbackResult(null, pendingQuestions);

    expect(result?.questions).toHaveLength(1);
    expect(result?.suggestedReplyFormat).toContain("discord-ux");
    expect(renderOperatorFeedbackMarkdown(result)).toContain("Answer instructions");
  });

  it("normalizes structured questionnaire output", () => {
    const result = coerceOperatorFeedbackResult(
      {
        headline: "Need one operator decision",
        preface: "This is the last open choice before dispatch.",
        questions: [
          {
            questionId: "discord-ux",
            label: "Discord answer path",
            prompt: "Keep the slash-command fallback?",
            whyItMatters: "It defines how Maverick captures decisions.",
            options: ["/workstream answer-plan", "freeform replies"],
            recommendedOption: "/workstream answer-plan",
          },
        ],
        answerInstructions: "Reply with /workstream answer-plan.",
        suggestedReplyFormat: "discord-ux: /workstream answer-plan",
      },
      pendingQuestions,
    );

    expect(result?.headline).toContain("operator decision");
    expect(result?.questions[0]?.recommendedOption).toBe("/workstream answer-plan");
    expect(renderOperatorFeedbackMarkdown(result)).toContain("Discord answer path");
  });
});
