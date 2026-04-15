import type { ModelingResult } from "./types.js";

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

export function parseModelingResult(
  structured: Record<string, unknown> | null,
  fallbackSummary: string,
): ModelingResult {
  if (!structured || !isRecord(structured)) {
    return {
      systemSummary: fallbackSummary,
      mermaid: "flowchart TD\n  A[Operator request] --> B[Planning context]\n  B --> C[Execution]",
      keyEntities: [],
      criticalFlows: [],
      openQuestions: [],
    };
  }

  return {
    systemSummary: asTrimmedString(structured.systemSummary) || fallbackSummary,
    mermaid:
      asTrimmedString(structured.mermaid) ||
      "flowchart TD\n  A[Operator request] --> B[Planning context]\n  B --> C[Execution]",
    keyEntities: asStringArray(structured.keyEntities),
    criticalFlows: asStringArray(structured.criticalFlows),
    openQuestions: asStringArray(structured.openQuestions),
  };
}

export function renderModelingMarkdown(result: ModelingResult): string {
  return [
    `System summary: ${result.systemSummary}`,
    result.keyEntities.length > 0 ? `Key entities: ${result.keyEntities.join("; ")}` : null,
    result.criticalFlows.length > 0 ? `Critical flows: ${result.criticalFlows.join("; ")}` : null,
    result.openQuestions.length > 0 ? `Open questions: ${result.openQuestions.join("; ")}` : null,
    "Mermaid:",
    "```mermaid",
    result.mermaid,
    "```",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
