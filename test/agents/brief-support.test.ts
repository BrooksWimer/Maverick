import { describe, expect, it } from "vitest";
import { coerceBriefAgentResult, renderBriefContent } from "../../src/agents/brief-support.js";

describe("brief support helpers", () => {
  it("renders a stable brief from structured agent output", () => {
    const structured = coerceBriefAgentResult(
      {
        sections: [
          {
            projectId: "maverick",
            headline: "Planning migration is ready for dispatch",
            delta: "Planning now persists structured context and resumes from operator answers.",
            blockers: ["Review and brief still need the same routing treatment."],
            nextActions: ["Route review and brief through src/agents."],
          },
        ],
        criticalAlerts: ["Review routing still uses the legacy path."],
        velocityTrend: "steady",
        stuckWorkstreams: [],
        risksIdentified: ["Skipping the agent layer would leave two competing abstractions."],
        recommendedActions: ["Finish the review and brief cutover."],
      },
      "```json\n{}\n```",
    );

    const content = renderBriefContent(structured, "```json\n{}\n```");
    expect(content).toContain("Velocity steady");
    expect(content).toContain("Planning migration is ready for dispatch");
    expect(content).toContain("Finish the review and brief cutover.");
  });
});
