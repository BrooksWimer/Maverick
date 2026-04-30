import type { IncidentTriageResult } from "./types.js";

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

export function coerceIncidentTriageResult(
  structured: Record<string, unknown> | null,
  output: string,
): IncidentTriageResult {
  if (!structured) {
    const fallback = output.trim() || "Incident triage returned no structured output.";
    return {
      severity: "high",
      rootCause: fallback,
      correlatedChanges: [],
      suggestedFix: fallback,
      affectedWorkstreams: [],
      escalationNeeded: true,
      escalationReason: "Incident triage did not return a structured result.",
    };
  }

  return {
    severity:
      structured.severity === "low" ||
      structured.severity === "medium" ||
      structured.severity === "high" ||
      structured.severity === "critical"
        ? structured.severity
        : "medium",
    rootCause: asTrimmedString(structured.rootCause) || "Root cause unclear.",
    correlatedChanges: asStringArray(structured.correlatedChanges),
    suggestedFix: asTrimmedString(structured.suggestedFix) || "Investigate the failing verification output further.",
    affectedWorkstreams: asStringArray(structured.affectedWorkstreams),
    escalationNeeded: structured.escalationNeeded === true,
    escalationReason: asTrimmedString(structured.escalationReason) || undefined,
  };
}

export function renderIncidentTriageSummary(result: IncidentTriageResult): string {
  return [
    `Severity: ${result.severity}`,
    `Root cause: ${result.rootCause}`,
    result.correlatedChanges.length > 0
      ? `Correlated changes: ${result.correlatedChanges.join("; ")}`
      : null,
    `Suggested fix: ${result.suggestedFix}`,
    result.affectedWorkstreams.length > 0
      ? `Affected workstreams: ${result.affectedWorkstreams.join(", ")}`
      : null,
    result.escalationNeeded
      ? `Escalation: ${result.escalationReason ?? "Operator input is required before continuing."}`
      : "Escalation: not required",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function buildIncidentContinuationInstruction(result: IncidentTriageResult): string {
  return [
    "Address the introduced verification failures from the last turn.",
    `Root cause: ${result.rootCause}`,
    `Primary fix: ${result.suggestedFix}`,
    result.correlatedChanges.length > 0 ? `Related changes: ${result.correlatedChanges.join("; ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function parseIncidentTriageResult(value: unknown): IncidentTriageResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return coerceIncidentTriageResult(value, "");
}
