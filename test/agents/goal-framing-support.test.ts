import { describe, expect, it } from "vitest";
import {
  parseGoalFrameResult,
  parseIntakeResult,
  renderGoalFrameMarkdown,
  renderIntakeMarkdown,
} from "../../src/agents/goal-framing-support.js";

describe("goal framing support", () => {
  it("normalizes intake results and renders a concise markdown summary", () => {
    const intake = parseIntakeResult(
      {
        request: "Move planning onto intake and goal framing.",
        scope: "Add pre-planning layers to the live planning flow.",
        outOfScope: "Full autonomous execution",
        acceptanceCriteria: ["Stored planning context includes intake"],
        risks: ["Existing planning summaries could drift"],
        complexity: "medium",
        recommendation: "proceed",
        clarificationQuestions: [],
      },
      "fallback instruction",
    );

    expect(intake.scope).toContain("pre-planning");
    expect(renderIntakeMarkdown(intake)).toContain("Acceptance criteria");
    expect(renderIntakeMarkdown(intake)).toContain("Recommendation: proceed");
  });

  it("derives a goal frame from structured output and falls back to intake context when needed", () => {
    const intake = parseIntakeResult(
      {
        request: "Improve autonomous planning.",
        scope: "Add better decision-gated planning support.",
        acceptanceCriteria: ["Stored goal framing exists"],
        risks: [],
        complexity: "medium",
        recommendation: "proceed",
      },
      "Improve autonomous planning.",
    );

    const goalFrame = parseGoalFrameResult(
      {
        objective: "Give planning a durable execution frame.",
        problemStatement: "Raw instructions alone are not enough for long-running work.",
        successCriteria: ["Planning persists operator-ready framing"],
        constraints: ["Keep existing behavior stable"],
        assumptions: ["Intake already scoped the work"],
        autonomyGuidance: "Proceed autonomously until a real decision gate appears.",
        operatorDecisionPolicy: "Escalate high-ramification choices only.",
      },
      intake,
    );

    const fallback = parseGoalFrameResult(null, intake);

    expect(goalFrame.objective).toContain("durable execution frame");
    expect(renderGoalFrameMarkdown(goalFrame)).toContain("Autonomy guidance");
    expect(fallback.objective).toContain("decision-gated planning");
  });
});
