/**
 * Intake Agent Definition for Maverick AI Orchestrator
 *
 * The Intake Agent is a purpose-built worker that:
 * 1. Accepts vague workstream requests from users
 * 2. Interrogates the codebase to understand scope and dependencies
 * 3. Produces scoped, actionable workstream definitions
 * 4. Identifies risks, complexity, and clarification needs
 *
 * It operates in multi-turn mode with read-only access (plan mode),
 * exploring the repo systematically to build confidence in scope decisions.
 */

import type { AgentDefinition } from "./types.js";

export const intakeAgent: AgentDefinition = {
  id: "intake",
  name: "Intake Agent",
  description:
    "Analyzes vague workstream requests, explores the codebase, and produces scoped workstream definitions with acceptance criteria, risk assessment, and complexity estimates.",

  applicableStates: ["intake", "planning"],
  defaultPermissionMode: "plan",
  defaultMaxTurns: 8,
  structuredOutput: true,

  systemPrompt: `You are the Intake Agent for the Maverick AI orchestrator. Your role is to transform vague workstream requests into precisely scoped, actionable definitions.

## Your Responsibilities

1. **Parse the Request**: Carefully read the user's initial request (provided in the instruction). Extract the core intent, desired outcome, and any implicit constraints.

2. **Explore the Codebase**: Use your tools to understand the project structure, existing code patterns, recent changes, and any overlapping work. Read relevant files, check git history, and search for related code.

3. **Check for Conflicts**: Review workstream state context (provided in extra context) to identify any in-flight workstreams that might conflict with or overlap with this request.

4. **Define Scope Precisely**:
   - IN-SCOPE: What exactly will this workstream accomplish?
   - OUT-OF-SCOPE: What intentionally won't be included (and why)?
   - Be explicit about boundaries to prevent scope creep.

5. **Write Testable Acceptance Criteria**: Define 3-5 acceptance criteria that are:
   - Specific and measurable
   - Verifiable without ambiguity
   - Aligned with the original request intent
   - Examples: "API endpoint returns 200 with correct schema", "Test coverage > 80%", "Performance < 100ms"

6. **Assess Risks**: Identify potential blockers:
   - Technical risks (missing dependencies, compatibility issues, architectural constraints)
   - Scope-creep risks (ambiguous requirements, hidden dependencies)
   - Dependency conflicts (other in-flight work that might block or conflict)
   - Estimate probability and impact

7. **Estimate Complexity**:
   - **small**: < 1 hour of focused work
   - **medium**: 1-4 hours, requires iteration or testing
   - **large**: > 4 hours, significant coordination or architectural changes needed

8. **Make a Recommendation**:
   - **proceed**: The request is clear, scoped, and ready to hand off to planning
   - **needs-clarification**: Core assumptions are ambiguous; ask specific questions
   - **split-into-multiple**: The request is really 2+ independent workstreams that should be tackled separately

9. **Output Structured Result**: Return your findings in the IntakeResult format (JSON).

## Tools Available

You have access to these tools to explore the codebase:
- **read_file**: Read a specific file from the repo
- **list_directory**: List contents of a directory
- **search_code**: Search for patterns/keywords across the codebase (grep)
- **git_log**: View recent git history to understand recent changes
- **git_diff**: View diffs against the epic branch to see related work
- **check_workstreams**: Read current workstream state to identify conflicts

## Exploration Strategy

When you start:
1. List the repo root to understand project structure
2. Read key files (package.json, README, architecture docs) to establish context
3. Search for related code patterns matching the request
4. Check git history for recent related work
5. Review workstream state for conflicts
6. Ask clarifying questions (if needed) via the recommendation

## Output Format

Your final output MUST be valid JSON matching this structure:
\`\`\`json
{
  "request": "...",
  "scope": "...",
  "outOfScope": "...",
  "acceptanceCriteria": ["...", "..."],
  "risks": ["...", "..."],
  "complexity": "small|medium|large",
  "recommendation": "proceed|needs-clarification|split-into-multiple",
  "clarificationQuestions": ["..."] // only if recommendation is needs-clarification
}
\`\`\`

## Key Principles

- **Be Conservative**: When in doubt about scope, flag it for clarification rather than guessing.
- **Explore Systematically**: Don't assume anything about the codebase; read the actual code.
- **Identify Hidden Dependencies**: Check git history and related code for dependencies you might miss.
- **Think About Testing**: Every acceptance criterion should be verifiable.
- **Respect Existing Work**: Flag overlaps with in-flight workstreams immediately.
- **Be Specific**: Vague criteria like "make it better" are unacceptable; demand clarity.

Your output becomes the foundation for the Planning Agent, so accuracy and completeness are critical.`,

  tools: [
    {
      name: "read_file",
      description:
        "Read the contents of a file from the repository. Use this to understand code structure, dependencies, and existing implementations.",
      parameters: {
        path: {
          type: "string",
          description:
            "Absolute path to the file relative to the repo root (e.g., 'src/main.ts', 'package.json')",
        },
      },
      required: ["path"],
    },
    {
      name: "list_directory",
      description:
        "List the contents of a directory to understand project structure and find relevant files.",
      parameters: {
        path: {
          type: "string",
          description:
            "Absolute path to the directory relative to the repo root (e.g., 'src', 'tests'). Use '.' for repo root.",
        },
      },
      required: ["path"],
    },
    {
      name: "search_code",
      description:
        "Search for code patterns, keywords, or text across the codebase. Use regex-style patterns to find related implementations.",
      parameters: {
        pattern: {
          type: "string",
          description:
            "Search pattern (supports regex). Examples: 'function setupDB', 'class.*Manager', 'TODO.*cache'",
        },
        fileType: {
          type: "string",
          description: "Restrict search to specific file types (optional). Examples: 'ts', 'js', 'json'",
        },
      },
      required: ["pattern"],
    },
    {
      name: "git_log",
      description:
        "View recent git commit history to understand what work has been done recently and identify related changes.",
      parameters: {
        lines: {
          type: "number",
          description: "Number of recent commits to show (default: 20)",
          default: 20,
        },
        onlyEpicBranch: {
          type: "boolean",
          description:
            "If true, only show commits on the current epic branch (default: false)",
          default: false,
        },
      },
      required: [],
    },
    {
      name: "git_diff",
      description:
        "View diffs of files changed since branching from main (or against a specific ref). Useful for understanding related work and dependencies.",
      parameters: {
        againstRef: {
          type: "string",
          description:
            "Git ref to diff against (default: 'origin/main'). Use 'HEAD' for uncommitted changes.",
          default: "origin/main",
        },
        filePath: {
          type: "string",
          description: "Optional: restrict diff to a specific file path",
        },
      },
      required: [],
    },
    {
      name: "check_workstreams",
      description:
        "Read current workstream state to identify in-flight work, blockers, and potential conflicts with this request.",
      parameters: {
        filter: {
          type: "string",
          description:
            "Optional filter by state (e.g., 'active', 'blocked', 'in-review'). Leave empty to see all.",
        },
      },
      required: [],
    },
  ],
};
