import type { GoalFrameResult, IntakeResult } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry) => entry.length > 0);
}

export function parseIntakeResult(
  structured: Record<string, unknown> | null,
  instruction: string,
): IntakeResult {
  if (!structured) {
    return {
      request: instruction,
      scope: instruction,
      outOfScope: "",
      acceptanceCriteria: [],
      risks: [],
      complexity: "medium",
      recommendation: "proceed",
      clarificationQuestions: [],
    };
  }

  return {
    request: asTrimmedString(structured.request) || instruction,
    scope: asTrimmedString(structured.scope) || instruction,
    outOfScope: asTrimmedString(structured.outOfScope),
    acceptanceCriteria: asStringArray(structured.acceptanceCriteria),
    risks: asStringArray(structured.risks),
    complexity:
      structured.complexity === "small" ||
      structured.complexity === "medium" ||
      structured.complexity === "large"
        ? structured.complexity
        : "medium",
    recommendation:
      structured.recommendation === "needs-clarification" ||
      structured.recommendation === "split-into-multiple" ||
      structured.recommendation === "proceed"
        ? structured.recommendation
        : "proceed",
    clarificationQuestions: asStringArray(structured.clarificationQuestions),
  };
}

export function parseGoalFrameResult(
  structured: Record<string, unknown> | null,
  intake: IntakeResult,
): GoalFrameResult {
  if (!structured) {
    return {
      objective: intake.scope || intake.request,
      problemStatement: intake.request,
      successCriteria: intake.acceptanceCriteria,
      constraints: intake.outOfScope ? [intake.outOfScope] : [],
      assumptions: [],
      autonomyGuidance: "Keep work moving autonomously until a real decision gate appears.",
      operatorDecisionPolicy: "Escalate missing facts and high-ramification architectural or scope choices.",
    };
  }

  return {
    objective: asTrimmedString(structured.objective) || intake.scope || intake.request,
    problemStatement: asTrimmedString(structured.problemStatement) || intake.request,
    successCriteria: asStringArray(structured.successCriteria).length > 0
      ? asStringArray(structured.successCriteria)
      : intake.acceptanceCriteria,
    constraints: asStringArray(structured.constraints),
    assumptions: asStringArray(structured.assumptions),
    autonomyGuidance:
      asTrimmedString(structured.autonomyGuidance) ||
      "Keep work moving autonomously until a real decision gate appears.",
    operatorDecisionPolicy:
      asTrimmedString(structured.operatorDecisionPolicy) ||
      "Escalate missing facts and high-ramification choices.",
  };
}

export function renderIntakeMarkdown(intake: IntakeResult): string {
  return [
    `Request: ${intake.request}`,
    `Scope: ${intake.scope}`,
    intake.outOfScope ? `Out of scope: ${intake.outOfScope}` : null,
    intake.acceptanceCriteria.length > 0
      ? `Acceptance criteria: ${intake.acceptanceCriteria.join("; ")}`
      : null,
    intake.risks.length > 0 ? `Risks: ${intake.risks.join("; ")}` : null,
    `Complexity: ${intake.complexity}`,
    `Recommendation: ${intake.recommendation}`,
    intake.clarificationQuestions && intake.clarificationQuestions.length > 0
      ? `Clarification questions: ${intake.clarificationQuestions.join("; ")}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function renderGoalFrameMarkdown(goalFrame: GoalFrameResult): string {
  return [
    `Objective: ${goalFrame.objective}`,
    `Problem: ${goalFrame.problemStatement}`,
    goalFrame.successCriteria.length > 0
      ? `Success criteria: ${goalFrame.successCriteria.join("; ")}`
      : null,
    goalFrame.constraints.length > 0
      ? `Constraints: ${goalFrame.constraints.join("; ")}`
      : null,
    goalFrame.assumptions.length > 0
      ? `Assumptions: ${goalFrame.assumptions.join("; ")}`
      : null,
    `Autonomy guidance: ${goalFrame.autonomyGuidance}`,
    `Operator decision policy: ${goalFrame.operatorDecisionPolicy}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
