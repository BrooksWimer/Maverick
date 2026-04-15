import type { BriefResult, BriefSection } from "./types.js";

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

function normalizeSection(value: unknown): BriefSection | null {
  if (!isRecord(value)) {
    return null;
  }

  const projectId = asTrimmedString(value.projectId);
  const headline = asTrimmedString(value.headline);
  const delta = asTrimmedString(value.delta);
  if (!projectId || !headline || !delta) {
    return null;
  }

  return {
    projectId,
    headline,
    delta,
    blockers: asStringArray(value.blockers),
    nextActions: asStringArray(value.nextActions),
  };
}

function extractNarrative(output: string): string {
  return output.replace(/```(?:json)?\s*[\s\S]+?\s*```/i, "").trim();
}

export function coerceBriefAgentResult(
  structured: Record<string, unknown> | null,
  output: string,
): BriefResult {
  if (!structured) {
    return {
      sections: [],
      criticalAlerts: [],
      velocityTrend: "steady",
      stuckWorkstreams: [],
      risksIdentified: [],
      recommendedActions: [],
    };
  }

  return {
    sections: Array.isArray(structured.sections)
      ? structured.sections
          .map((section) => normalizeSection(section))
          .filter((section): section is BriefSection => section !== null)
      : [],
    criticalAlerts: asStringArray(structured.criticalAlerts),
    velocityTrend:
      structured.velocityTrend === "accelerating" ||
      structured.velocityTrend === "steady" ||
      structured.velocityTrend === "slowing" ||
      structured.velocityTrend === "stalled"
        ? structured.velocityTrend
        : "steady",
    stuckWorkstreams: asStringArray(structured.stuckWorkstreams),
    risksIdentified: asStringArray(structured.risksIdentified),
    recommendedActions: asStringArray(structured.recommendedActions),
  };
}

export function renderBriefContent(
  structured: BriefResult,
  output: string,
): string {
  const narrative = extractNarrative(output);
  if (narrative) {
    return narrative;
  }

  const headline = `Velocity ${structured.velocityTrend}; ${structured.criticalAlerts.length} critical alert${structured.criticalAlerts.length === 1 ? "" : "s"}.`;
  const projectSnapshot =
    structured.sections.length > 0
      ? structured.sections
          .map((section) => {
            const lines = [
              `- ${section.projectId}: ${section.headline}`,
              `  Delta: ${section.delta}`,
              section.blockers.length > 0 ? `  Blockers: ${section.blockers.join("; ")}` : null,
              section.nextActions.length > 0 ? `  Next: ${section.nextActions.join("; ")}` : null,
            ].filter((line): line is string => line !== null);
            return lines.join("\n");
          })
          .join("\n")
      : "- No project deltas recorded.";

  const criticalAlerts =
    structured.criticalAlerts.length > 0
      ? structured.criticalAlerts.map((alert) => `- ${alert}`).join("\n")
      : "- None.";

  const recommendedActions =
    structured.recommendedActions.length > 0
      ? structured.recommendedActions.map((action) => `- ${action}`).join("\n")
      : "- None.";

  return [
    headline,
    "",
    "Top Priorities:",
    criticalAlerts,
    "",
    "Project Snapshot:",
    projectSnapshot,
    "",
    "Upcoming Items:",
    recommendedActions,
  ].join("\n");
}
