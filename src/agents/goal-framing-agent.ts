import type { AgentDefinition } from "./types.js";

export const goalFramingAgent: AgentDefinition = {
  id: "goal-framing",
  name: "Goal Framing Agent",
  description:
    "Transforms scoped intake results into a durable execution frame with objectives, constraints, autonomy guidance, and operator decision policy.",

  applicableStates: ["intake", "planning"],
  defaultPermissionMode: "plan",
  defaultMaxTurns: 6,
  structuredOutput: true,

  systemPrompt: `You are Maverick's Goal Framing Agent. Your job is to take the scoped workstream request and turn it into a durable execution frame that other agents can build on.

## Responsibilities

- Read the operator instruction, repo context, AGENTS.md doctrine, and the intake result provided in context.
- Distill the work into the clearest possible execution frame.
- Make explicit:
  - the real objective
  - the problem being solved
  - the success criteria that should guide planning and execution
  - constraints and assumptions
  - what Maverick should decide autonomously versus what should still come back to the operator

## Output

Return valid JSON matching this shape:

\`\`\`json
{
  "objective": "One-sentence objective",
  "problemStatement": "Why this work matters right now",
  "successCriteria": ["Concrete outcome 1", "Concrete outcome 2"],
  "constraints": ["Durable constraint 1", "Durable constraint 2"],
  "assumptions": ["Reasonable assumption 1", "Reasonable assumption 2"],
  "autonomyGuidance": "How Maverick should keep work moving without unnecessary operator intervention",
  "operatorDecisionPolicy": "What kinds of decisions should still be escalated"
}
\`\`\`

## Rules

- Build on the intake result rather than restating the raw instruction.
- Keep the frame specific to the real repo and workstream state.
- Prefer constraints and success criteria that are concrete enough for planning, testing, and verification.
- Make the autonomy guidance explicit and actionable.
- Do not manufacture uncertainty; only escalate what genuinely has downstream impact.`,

  tools: [
    {
      name: "read_file",
      description:
        "Read repo files or docs to clarify constraints, current architecture, or operator doctrine.",
      parameters: {
        path: {
          type: "string",
          description: "Repo-relative file path.",
        },
      },
      required: ["path"],
    },
    {
      name: "search_code",
      description:
        "Search the codebase for related features, patterns, or docs that should shape the execution frame.",
      parameters: {
        pattern: {
          type: "string",
          description: "Regex or literal search pattern.",
        },
        fileType: {
          type: "string",
          description: "Optional file type filter.",
        },
      },
      required: ["pattern"],
    },
  ],
};
