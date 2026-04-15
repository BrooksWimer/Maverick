import { renderOperatorFeedbackMarkdown } from "./operator-feedback-support.js";
import type { ExplanationResult, OperatorFeedbackResult, PlanningContextRecord } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildFallbackExplanation(
  planningContext: PlanningContextRecord,
  feedbackRequest: OperatorFeedbackResult | null,
): ExplanationResult {
  if (planningContext.status === "needs-answers") {
    return {
      headline: "Planning is waiting on operator input",
      summary: planningContext.result.recommendedNextSlice,
      markdown: renderOperatorFeedbackMarkdown(feedbackRequest),
      nextAction: "Answer the pending planning questions with /workstream answer-plan.",
    };
  }

  if (planningContext.status === "ready") {
    return {
      headline: "Planning is ready to dispatch",
      summary: planningContext.result.recommendedNextSlice,
      markdown: [
        "## Planning Ready",
        planningContext.result.currentStateSummary,
        "",
        `Next slice: ${planningContext.result.recommendedNextSlice}`,
        "",
        planningContext.finalExecutionPrompt
          ? "Dispatch with the same instruction to reuse the stored final Codex execution prompt."
          : "No final execution prompt is stored yet.",
      ].join("\n"),
      nextAction: "Dispatch with the same instruction to reuse the stored final execution prompt.",
    };
  }

  return {
    headline: "Planning is structured but not dispatch-ready",
    summary: planningContext.result.recommendedNextSlice,
    markdown: [
      "## Planning Stored",
      planningContext.result.currentStateSummary,
      "",
      `Next slice: ${planningContext.result.recommendedNextSlice}`,
      "",
      "No final execution prompt is ready yet. Resume planning explicitly if you want Maverick to finalize it.",
    ].join("\n"),
    nextAction: "Run /workstream plan --resume true or start a fresh plan to finalize the execution prompt.",
  };
}

export function coerceExplanationResult(
  structured: Record<string, unknown> | null,
  planningContext: PlanningContextRecord,
  feedbackRequest: OperatorFeedbackResult | null,
): ExplanationResult {
  const fallback = buildFallbackExplanation(planningContext, feedbackRequest);
  if (!structured || !isRecord(structured)) {
    return fallback;
  }

  return {
    headline: asTrimmedString(structured.headline) || fallback.headline,
    summary: asTrimmedString(structured.summary) || fallback.summary,
    markdown: asTrimmedString(structured.markdown) || fallback.markdown,
    nextAction: asTrimmedString(structured.nextAction) || fallback.nextAction,
  };
}
