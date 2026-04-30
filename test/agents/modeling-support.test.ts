import { describe, expect, it } from "vitest";
import { parseModelingResult, renderModelingMarkdown } from "../../src/agents/modeling-support.js";

describe("modeling support", () => {
  it("normalizes structured modeling output and renders mermaid markdown", () => {
    const result = parseModelingResult(
      {
        systemSummary: "Planning depends on persisted workstream state and Discord handoff.",
        mermaid: "flowchart TD\n  A[Plan] --> B[Dispatch]",
        keyEntities: ["orchestrator", "discord bot"],
        criticalFlows: ["planning", "dispatch"],
        openQuestions: ["Whether poll UX is worth the added surface area"],
      },
      "fallback",
    );

    expect(result.keyEntities).toContain("orchestrator");
    expect(renderModelingMarkdown(result)).toContain("```mermaid");
    expect(renderModelingMarkdown(result)).toContain("flowchart TD");
  });
});
