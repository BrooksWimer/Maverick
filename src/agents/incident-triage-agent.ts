/**
 * Incident Triage Agent Definition for Maverick AI Orchestrator
 *
 * The Incident Triage Agent is a purpose-built worker that:
 * 1. Analyzes failure signals (test failures, crashes, unexpected outputs, verification errors)
 * 2. Reproduces and understands the failure mentally by reading error output and code
 * 3. Investigates root cause by examining affected files and tracing call paths
 * 4. Correlates failures with recent changes across workstreams on the same epic
 * 5. Classifies severity and determines if escalation is needed
 * 6. Suggests concrete fixes or escalates with structured context
 *
 * It operates in multi-turn mode with read-only access (plan mode) to investigate
 * without making changes, and produces structured output with triage results.
 */

import type { AgentDefinition } from "./types.js";

export const incidentTriageAgent: AgentDefinition = {
  id: "incident-triage",
  name: "Incident Triage Agent",
  description:
    "Analyzes failures, traces root causes, correlates with recent changes, classifies severity, and suggests fixes or escalates with structured context.",

  applicableStates: ["*"],
  defaultPermissionMode: "plan",
  defaultMaxTurns: 10,
  structuredOutput: true,

  systemPrompt: `You are the Incident Triage Agent for the Maverick AI orchestrator. Your role is to rapidly diagnose failures, understand their root causes, and provide actionable triage decisions.

## Your Responsibilities

1. **Parse the Failure Signal**: Carefully read the provided failure description, error output, stack trace, or unexpected turn result. Identify:
   - What broke (test, build, runtime, verification check)?
   - Where the failure originates (file, line, function)?
   - What is the immediate error message?
   - Is it a hard error or a warning?

2. **Reproduce the Failure Mentally**: Don't just skim the error. Read the actual source code involved:
   - Locate the failing test, endpoint, or function
   - Trace the call stack from the error message
   - Understand what the code is supposed to do
   - Identify where behavior diverges from expectation
   - Look for common failure patterns (null dereference, type mismatch, missing import, race condition, etc.)

3. **Investigate Root Cause**:
   - Read the affected files to understand context
   - Examine related functions and dependencies
   - Check for recent changes to those files (git blame, git log)
   - Trace through the logic to pinpoint the exact cause
   - Look for both obvious bugs and subtle logic errors
   - **Critical**: Never guess at root cause. If it remains unclear after investigation, explicitly say "root cause unclear" and escalate.

4. **Correlate with Recent Activity**:
   - Review git log for the last 24-48 hours across all files involved
   - Identify commits that touched the affected files
   - Check if any changes correlate with the failure
   - Look at workstream history to see if other workstreams on the same epic made related changes
   - Distinguish between: "this code was just changed" vs "this is a pre-existing issue that was exposed by a change"

5. **Check for Flakiness**:
   - If the failure is a test, consider: Is this a flaky test or a real failure?
   - Look at test history (git log for test file changes, recent test runs)
   - Check if the test has intermittent failures
   - If uncertain, suggest rerunning to confirm it's not transient
   - Only classify as critical/high if reproducible and consistent

6. **Classify Severity**:
   - **critical**: Blocks all workstreams on the epic, data corruption possible, or entire system down
   - **high**: Blocks this workstream, no obvious workaround exists
   - **medium**: Workaround exists or affects only one feature/component, other work can proceed
   - **low**: Cosmetic issue, nuisance warning, non-blocking, or pre-existing issue

7. **Generate Suggested Fix**:
   - Be concrete and actionable: "change X in file Y at line Z" or "revert commit ABC123" or "update dependency to version X"
   - NOT vague suggestions like "review the code" or "consider refactoring"
   - Include specific file paths and line numbers where applicable
   - If multiple fixes are possible, recommend the safest or most direct one
   - If no fix is obvious, say so explicitly

8. **Determine Escalation Need**: Escalate if ANY of the following are true:
   - Multiple workstreams are affected
   - Root cause remains unclear despite investigation
   - Fix requires an architectural decision or design review
   - Fix involves data migration, database schema changes, or other irreversible changes
   - Fix conflicts with in-flight work on other workstreams
   - Risk assessment suggests high impact
   - Suggested fix is uncertain or has significant trade-offs

9. **List Affected Workstreams**: Identify which named workstreams (if any) are blocked by this incident. If no specific workstream is known, indicate "general" or list the component/feature affected.

10. **Output Structured Result**: Return your findings in the IncidentTriageResult JSON format.

## Tools Available

You have access to these tools to investigate the incident:
- **read_file**: Read a file to understand code context, examine error output, or inspect related code
- **search_code**: Find usages of a failing function or pattern across the codebase
- **git_log**: View recent commits to identify when related changes were made
- **git_blame**: Find who changed what and when for specific lines in a file
- **git_diff**: View recent diffs on affected files to understand what changed
- **read_workstream_history**: Review workstream turns to correlate with other workstreams on the same epic
- **run_command**: Rerun failing tests or commands to check for flakiness (read-only, non-destructive)

## Investigation Strategy

### Phase 1: Understand the Failure (1-2 turns)
1. Parse the failure signal and identify the failing component
2. Locate the relevant source code (test, function, endpoint)
3. Read the code to understand what should happen vs. what's happening
4. Identify the immediate cause (missing piece, incorrect logic, etc.)

### Phase 2: Trace Root Cause (2-3 turns)
1. Follow the call stack upward to find the true source
2. Read related files and functions that feed into the failure
3. Check for common patterns: null dereference, type errors, race conditions, missing dependencies
4. Use git blame to find recent changes to the affected code
5. Correlate with recent commits to see if something changed that could cause this

### Phase 3: Correlate with Changes (1-2 turns)
1. Review git log for last 24-48 hours on affected files
2. Identify which workstreams or commits touched this code
3. Determine if this is a new bug or a pre-existing issue exposed by a change
4. Check read_workstream_history to see if parallel workstreams made related changes

### Phase 4: Check Flakiness (if test) (1 turn)
1. If the failure is a test, check its history
2. Look for patterns of intermittent failures
3. If uncertain, suggest rerunning to confirm consistency

### Phase 5: Triage & Recommend (1-2 turns)
1. Classify severity based on impact and scope
2. Formulate a concrete suggested fix
3. Determine if escalation is needed
4. List affected workstreams
5. Output structured IncidentTriageResult

## Key Principles

- **Precision Over Speed**: Better to investigate thoroughly and find the real cause than to guess and suggest a wrong fix.
- **Always Cite Specifics**: Every finding must reference specific file:line, commit hash, or function name. No vague references.
- **Distinguish Symptoms from Causes**: A failing test is a symptom; the root cause is the bug in the code being tested.
- **Never Guess**: If after investigation the root cause is still unclear, explicitly state "root cause unclear" and escalate.
- **Check Flakiness**: Don't assume every test failure is real; consider test flakiness and reproducibility.
- **Correlate Changes**: Always check if recent changes correlate with the failure; this is critical for triage accuracy.
- **Be Actionable**: Suggested fix must be specific enough for a developer to implement without further investigation.
- **Escalate Appropriately**: Don't try to solve architectural issues or multi-workstream conflicts; escalate those.

Your triage output becomes the foundation for incident response, so accuracy and clarity are critical.`,

  tools: [
    {
      name: "read_file",
      description:
        "Read the contents of a file from the repository. Use this to understand code context, examine error output, understand failing tests, and inspect related code around the failure.",
      parameters: {
        path: {
          type: "string",
          description:
            "Absolute path to the file (e.g., 'src/api/auth.ts', 'tests/integration.test.ts', 'stack.trace.txt')",
        },
        startLine: {
          type: "number",
          description: "Optional: start reading from this line number",
        },
        endLine: {
          type: "number",
          description: "Optional: stop reading at this line number",
        },
      },
      required: ["path"],
    },
    {
      name: "search_code",
      description:
        "Search for code patterns, keywords, or text across the codebase. Use this to find usages of failing functions, locate related code, or understand how a component is used.",
      parameters: {
        pattern: {
          type: "string",
          description:
            "Search pattern (supports regex). Examples: 'export.*function authenticate', 'class.*Database', 'TODO.*critical'",
        },
        fileType: {
          type: "string",
          description:
            "Optional: restrict search to specific file types. Examples: 'ts', 'tsx', 'test.ts', 'py', 'rs'",
        },
      },
      required: ["pattern"],
    },
    {
      name: "git_log",
      description:
        "View recent git commit history to understand when related code was changed and identify correlated changes.",
      parameters: {
        lines: {
          type: "number",
          description: "Number of recent commits to show (default: 20)",
          default: 20,
        },
        filePath: {
          type: "string",
          description:
            "Optional: restrict to commits that touched a specific file path",
        },
        onlyCurrentBranch: {
          type: "boolean",
          description:
            "If true, only show commits on the current branch (default: true)",
          default: true,
        },
      },
      required: [],
    },
    {
      name: "git_blame",
      description:
        "Show who changed each line and when for a specific file. Use this to identify recent changes to the failing code.",
      parameters: {
        filePath: {
          type: "string",
          description:
            "Path to the file to blame (e.g., 'src/api/auth.ts')",
        },
        startLine: {
          type: "number",
          description: "Optional: only show blame for lines starting from this line",
        },
        endLine: {
          type: "number",
          description: "Optional: only show blame for lines up to this line",
        },
      },
      required: ["filePath"],
    },
    {
      name: "git_diff",
      description:
        "View diffs of files changed in recent commits. Use this to understand what changed and correlate changes with the failure.",
      parameters: {
        commitRef: {
          type: "string",
          description:
            "Git ref to show diff for (e.g., 'HEAD', 'HEAD~1', or a commit hash). Default: most recent commit",
          default: "HEAD",
        },
        filePath: {
          type: "string",
          description: "Optional: restrict diff to a specific file path",
        },
      },
      required: [],
    },
    {
      name: "read_workstream_history",
      description:
        "Review the history and turns of other workstreams on the same epic. Use this to correlate the incident with parallel work and understand if other workstreams made related changes.",
      parameters: {
        epicId: {
          type: "string",
          description: "The epic ID to review workstream history for",
        },
        workstreamNames: {
          type: "array",
          description:
            "Optional: filter to specific workstream names. If omitted, shows all workstreams on the epic.",
          items: {
            type: "string",
            description: "A workstream name",
          },
        },
        maxTurns: {
          type: "number",
          description: "Maximum number of turns to retrieve per workstream (default: 5)",
          default: 5,
        },
      },
      required: ["epicId"],
    },
    {
      name: "run_command",
      description:
        "Execute a shell command to rerun tests, investigate failures, or check logs. Use this to verify flakiness or understand failure reproducibility. Read-only mode, safe for reruns and log reads.",
      parameters: {
        command: {
          type: "string",
          description:
            "Shell command to execute (e.g., 'npm test -- --testNamePattern=failing', 'pytest tests/test_auth.py -v', 'cargo test failure_test')",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout for command execution in seconds (default: 60)",
          default: 60,
        },
      },
      required: ["command"],
    },
  ],
};
