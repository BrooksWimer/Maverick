import { describe, expect, it } from "vitest";
import { parseTestDesignResult, renderTestDesignMarkdown } from "../../src/agents/test-design-support.js";

describe("test design support", () => {
  it("normalizes structured test design output and renders checklist markdown", () => {
    const result = parseTestDesignResult(
      {
        strategySummary: "Start with the planning loop and dispatch guard.",
        testCases: [
          {
            name: "Dispatch guard",
            scope: "integration",
            purpose: "Ensures unresolved planning questions block dispatch.",
            files: ["test/orchestrator/planning-agent.test.ts"],
          },
        ],
        verificationChecklist: ["Run lint", "Run planning tests"],
        suggestedCommands: ["npm run lint", "npx vitest run test/orchestrator/planning-agent.test.ts"],
      },
      "fallback",
    );

    expect(result.testCases[0]?.scope).toBe("integration");
    expect(renderTestDesignMarkdown(result)).toContain("Dispatch guard");
    expect(renderTestDesignMarkdown(result)).toContain("Suggested commands");
  });
});
