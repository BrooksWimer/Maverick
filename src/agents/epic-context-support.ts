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

export function renderEpicContextAnalysis(
  structured: Record<string, unknown> | null,
  output: string,
): string {
  if (!structured || !isRecord(structured)) {
    return output.trim();
  }

  const summary = asTrimmedString(structured.summary);
  const contextForNextWorkstream = asTrimmedString(structured.contextForNextWorkstream);
  const completedWorkstreams = asStringArray(structured.completedWorkstreams);
  const activeWorkstreams = asStringArray(structured.activeWorkstreams);
  const blockedItems = asStringArray(structured.blockedItems);
  const recentDecisions = asStringArray(structured.recentDecisions);
  const openQuestions = asStringArray(structured.openQuestions);

  return [
    summary ? `Summary: ${summary}` : null,
    activeWorkstreams.length > 0 ? `Active workstreams: ${activeWorkstreams.join("; ")}` : null,
    completedWorkstreams.length > 0 ? `Completed workstreams: ${completedWorkstreams.join("; ")}` : null,
    blockedItems.length > 0 ? `Blocked items: ${blockedItems.join("; ")}` : null,
    recentDecisions.length > 0 ? `Recent decisions: ${recentDecisions.join("; ")}` : null,
    openQuestions.length > 0 ? `Open questions: ${openQuestions.join("; ")}` : null,
    contextForNextWorkstream ? `Context for next workstream: ${contextForNextWorkstream}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
