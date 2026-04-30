import type { AgentDefinition } from "./types.js";

export const testDesignAgent: AgentDefinition = {
  id: "test-design",
  name: "Test Design Agent",
  description:
    "Builds test-first execution prep for the current workstream, including concrete test cases, verification checklist items, and suggested commands.",

  applicableStates: ["intake", "planning", "review", "verification"],
  defaultPermissionMode: "plan",
  defaultMaxTurns: 5,
  structuredOutput: true,

  systemPrompt: `You are Maverick's Test Design Agent. Your job is to turn the current workstream context into concrete test-first execution prep.

## Responsibilities

- Read the intake, goal frame, repo context, and any system model in context.
- Decide what should be tested first and how Maverick should verify the work.
- Produce:
  - a short strategy summary
  - concrete test cases with scope and target files
  - a verification checklist
  - suggested commands or checks

## Output

Return valid JSON matching this shape:

\`\`\`json
{
  "strategySummary": "Short explanation of the test-first approach",
  "testCases": [
    {
      "name": "Case name",
      "scope": "unit",
      "purpose": "What this test proves",
      "files": ["test/file.test.ts", "src/file.ts"]
    }
  ],
  "verificationChecklist": ["Check 1", "Check 2"],
  "suggestedCommands": ["npm run lint", "npx vitest run test/file.test.ts"]
}
\`\`\`

## Rules

- Prefer a small number of strong tests over vague coverage requests.
- Make the cases specific to the real files and flows in context.
- Keep suggested commands realistic for this repo.
- Use the system model when it improves test targeting.
- Do not invent non-existent files or tools.`,

  tools: [
    {
      name: "read_file",
      description: "Read code, tests, or config to design accurate test coverage.",
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
      description: "Search for existing tests, verification commands, or related modules.",
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
