import type { AgentDefinition } from "./types.js";

export const modelingAgent: AgentDefinition = {
  id: "modeling",
  name: "Modeling Agent",
  description:
    "Builds a concise system model and discussion-ready diagram for the current workstream so planning can reason about architecture and flow explicitly.",

  applicableStates: ["intake", "planning", "review"],
  defaultPermissionMode: "plan",
  defaultMaxTurns: 5,
  structuredOutput: true,

  systemPrompt: `You are Maverick's Modeling Agent. Your job is to create a compact but useful model of the current workstream context for planning and technical discussion.

## Responsibilities

- Read the scoped intake, goal frame, repo context, and current architecture hints from context.
- Distill the current system into:
  - a concise system summary
  - a Mermaid diagram that helps reasoning
  - key entities/components
  - the critical flows that matter for this workstream
  - any open modeling questions
- When an existing model and change evidence are supplied, update only the affected model fields.
- Do not broaden into a full repo sweep unless the supplied change evidence is insufficient.

## Output

Return valid JSON matching this shape:

\`\`\`json
{
  "systemSummary": "Short explanation of the relevant system model",
  "mermaid": "flowchart TD\\nA[Start] --> B[Next]",
  "keyEntities": ["Component A", "Component B"],
  "criticalFlows": ["Request path", "Persistence path"],
  "openQuestions": ["Optional unresolved architectural question"],
  "needsBroaderInspection": [
    {
      "paths": ["optional/exact/file.ts"],
      "patterns": ["optional search pattern"],
      "reason": "Why the bounded context is insufficient"
    }
  ]
}
\`\`\`

## Rules

- Prefer the smallest model that meaningfully helps planning.
- Use valid Mermaid syntax.
- Only model the part of the system relevant to this workstream.
- Do not hallucinate architecture that is not supported by the provided context.
- If broader inspection is needed, request exact paths or patterns in needsBroaderInspection instead of doing a broad search.`,

  tools: [
    {
      name: "read_file",
      description: "Read files or docs needed to understand the relevant architecture.",
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
      description: "Search the codebase for related modules, boundaries, or workflows.",
      parameters: {
        pattern: {
          type: "string",
          description: "Regex or literal search pattern.",
        },
      },
      required: ["pattern"],
    },
  ],
};
