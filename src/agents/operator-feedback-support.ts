import type { OperatorFeedbackQuestion, OperatorFeedbackResult, PendingPlanningDecision } from "./types.js";

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

function fallbackQuestion(question: PendingPlanningDecision): OperatorFeedbackQuestion {
  return {
    questionId: question.id,
    label: question.kind === "important-decision" ? "Decision" : "Required answer",
    prompt: question.question,
    whyItMatters: question.whyItMatters,
    options: question.options ?? [],
  };
}

function normalizeQuestion(
  value: unknown,
  fallbackById: Map<string, PendingPlanningDecision>,
): OperatorFeedbackQuestion | null {
  if (!isRecord(value)) {
    return null;
  }

  const questionId = asTrimmedString(value.questionId);
  if (!questionId) {
    return null;
  }

  const fallback = fallbackById.get(questionId);
  if (!fallback) {
    return null;
  }

  return {
    questionId,
    label: asTrimmedString(value.label) || fallbackQuestion(fallback).label,
    prompt: asTrimmedString(value.prompt) || fallback.question,
    whyItMatters: asTrimmedString(value.whyItMatters) || fallback.whyItMatters,
    options: asStringArray(value.options).length > 0 ? asStringArray(value.options) : fallback.options ?? [],
    recommendedOption: asTrimmedString(value.recommendedOption) || undefined,
  };
}

export function coerceOperatorFeedbackResult(
  structured: Record<string, unknown> | null,
  pendingQuestions: PendingPlanningDecision[],
): OperatorFeedbackResult | null {
  if (pendingQuestions.length === 0) {
    return null;
  }

  const fallbackById = new Map(pendingQuestions.map((question) => [question.id, question] as const));
  const fallbackQuestions = pendingQuestions.map((question) => fallbackQuestion(question));
  if (!structured) {
    return {
      headline: "Operator input needed",
      preface: "Maverick has a structured plan but still needs a small number of answers before dispatch is safe.",
      questions: fallbackQuestions,
      answerInstructions: "Respond with /workstream answer-plan using one line per answer: question-id: answer",
      suggestedReplyFormat: fallbackQuestions.map((question) => `${question.questionId}: <answer>`).join("\n"),
    };
  }

  const questions = Array.isArray(structured.questions)
    ? structured.questions
        .map((question) => normalizeQuestion(question, fallbackById))
        .filter((question): question is OperatorFeedbackQuestion => question !== null)
    : fallbackQuestions;

  return {
    headline: asTrimmedString(structured.headline) || "Operator input needed",
    preface:
      asTrimmedString(structured.preface) ||
      "Maverick has a structured plan but still needs a small number of answers before dispatch is safe.",
    questions: questions.length > 0 ? questions : fallbackQuestions,
    answerInstructions:
      asTrimmedString(structured.answerInstructions) ||
      "Respond with /workstream answer-plan using one line per answer: question-id: answer",
    suggestedReplyFormat:
      asTrimmedString(structured.suggestedReplyFormat) ||
      fallbackQuestions.map((question) => `${question.questionId}: <answer>`).join("\n"),
  };
}

export function renderOperatorFeedbackMarkdown(result: OperatorFeedbackResult | null): string {
  if (!result) {
    return "No operator questionnaire recorded.";
  }

  return [
    `## ${result.headline}`,
    result.preface,
    "",
    ...result.questions.map((question, index) =>
      [
        `${index + 1}. **${question.label}** \`${question.questionId}\``,
        `${question.prompt}`,
        `Why it matters: ${question.whyItMatters}`,
        question.options.length > 0 ? `Options: ${question.options.join(" | ")}` : null,
        question.recommendedOption ? `Recommended: ${question.recommendedOption}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    ),
    "",
    `Answer instructions: ${result.answerInstructions}`,
    "Suggested reply:",
    "```text",
    result.suggestedReplyFormat,
    "```",
  ].join("\n");
}
