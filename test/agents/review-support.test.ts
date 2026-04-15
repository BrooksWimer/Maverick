import { describe, expect, it } from "vitest";
import { coerceReviewAgentResult } from "../../src/agents/review-support.js";

describe("coerceReviewAgentResult", () => {
  it("formats structured agent review findings for the existing review surface", () => {
    const result = coerceReviewAgentResult(
      {
        verdict: "needs-changes",
        severity: "major",
        passes: [
          { name: "Security", status: "clean", findingCount: 0 },
          { name: "Correctness", status: "findings", findingCount: 1 },
        ],
        securityFindings: [],
        architectureFindings: [],
        correctnessFindings: [
          {
            file: "src/orchestrator/orchestrator.ts",
            line: 42,
            severity: "error",
            category: "missing-test",
            description: "The decision resume path is untested.",
            suggestion: "Add an integration test for answer merging.",
          },
        ],
        conventionFindings: [],
        suggestions: ["Add the missing integration test."],
      },
      "```json\n{}\n```",
    );

    expect(result.severity).toBe("major");
    expect(result.findings).toContain("Verdict: needs-changes");
    expect(result.findings).toContain("src/orchestrator/orchestrator.ts:42");
    expect(result.suggestions).toEqual(["Add the missing integration test."]);
  });
});
