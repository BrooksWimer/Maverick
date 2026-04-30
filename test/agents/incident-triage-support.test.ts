import { describe, expect, it } from "vitest";
import {
  buildIncidentContinuationInstruction,
  coerceIncidentTriageResult,
  renderIncidentTriageSummary,
} from "../../src/agents/incident-triage-support.js";

describe("incident-triage-support", () => {
  it("normalizes structured triage output", () => {
    const result = coerceIncidentTriageResult(
      {
        severity: "medium",
        rootCause: "A stale branch comparison broke the verification diff.",
        correlatedChanges: ["src/orchestrator/orchestrator.ts"],
        suggestedFix: "Use the current worktree diff instead of assuming main exists.",
        affectedWorkstreams: ["verification migration"],
        escalationNeeded: false,
      },
      "done",
    );

    expect(result.severity).toBe("medium");
    expect(result.escalationNeeded).toBe(false);
    expect(buildIncidentContinuationInstruction(result)).toContain("Primary fix");
    expect(renderIncidentTriageSummary(result)).toContain("Root cause");
  });

  it("falls back to an escalation when triage output is missing", () => {
    const result = coerceIncidentTriageResult(null, "triage failed");

    expect(result.escalationNeeded).toBe(true);
    expect(result.rootCause).toContain("triage failed");
  });
});
