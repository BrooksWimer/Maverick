import { describe, expect, it } from "vitest";
import { buildReviewInstruction } from "../../src/claude/context-builder.js";
import { parseStructuredReviewOutput } from "../../src/claude/claude-adapter.js";

describe("buildReviewInstruction", () => {
  it("includes the grounded review evidence", () => {
    const instruction = buildReviewInstruction({
      projectId: "maverick",
      workstreamName: "Claude review",
      instruction: "Implement post-turn review",
      turnSummary: "Review path added",
      turnOutput: "Updated orchestrator and Discord bot",
      gitDiff: "diff --git a/src/orchestrator/orchestrator.ts b/src/orchestrator/orchestrator.ts",
      gitStatus: "## main\n M src/orchestrator/orchestrator.ts",
      epicCharter: null,
      testResults: "npm test passed",
    });

    expect(instruction).toContain("Implement post-turn review");
    expect(instruction).toContain("Updated orchestrator and Discord bot");
    expect(instruction).toContain("diff --git");
    expect(instruction).toContain("npm test passed");
  });
});

describe("parseStructuredReviewOutput", () => {
  it("parses JSON review payloads", () => {
    const result = parseStructuredReviewOutput(
      '{"severity":"major","findings":"Missing validation","suggestions":["Add tests"]}'
    );

    expect(result.severity).toBe("major");
    expect(result.findings).toBe("Missing validation");
    expect(result.suggestions).toEqual(["Add tests"]);
  });

  it("parses fenced JSON payloads", () => {
    const result = parseStructuredReviewOutput(
      '```json\n{"severity":"clean","findings":"Looks good","suggestions":[]}\n```'
    );

    expect(result.severity).toBe("clean");
    expect(result.findings).toBe("Looks good");
  });

  it("falls back to raw text when parsing fails", () => {
    const result = parseStructuredReviewOutput("plain text review");

    expect(result.severity).toBe("minor");
    expect(result.findings).toBe("plain text review");
  });
});
