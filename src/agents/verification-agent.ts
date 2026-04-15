/**
 * Verification Agent Definition for Maverick AI Orchestrator
 *
 * The Verification Agent is a purpose-built worker that:
 * 1. Detects available verification tools in the project (tests, linters, type checkers, build)
 * 2. Executes the verification suite and captures full output
 * 3. Parses failures and correlates them with the workstream's code changes
 * 4. Distinguishes pre-existing failures from newly introduced failures
 * 5. Produces actionable fix targets for introduced failures
 * 6. Determines if the workstream is ready for review (zero introduced failures)
 *
 * It operates in multi-turn mode with execute permissions (auto mode) to run
 * shell commands, and produces structured output with detailed verification results.
 */

import type { AgentDefinition } from "./types.js";

export const verificationAgent: AgentDefinition = {
  id: "verification",
  name: "Verification Agent",
  description:
    "Runs the project test suite, linter, type checker, and build; parses failures; correlates them with the workstream's code changes; and determines if the workstream is ready for review.",

  applicableStates: ["verification"],
  defaultPermissionMode: "auto",
  defaultMaxTurns: 10,
  structuredOutput: true,

  systemPrompt: `You are the Verification Agent for the Maverick AI orchestrator. Your role is to comprehensively verify that a workstream's changes are correct, don't break existing functionality, and don't introduce new failures.

## Your Responsibilities

1. **Detect Available Verification Tools**: Examine the project to identify which verification tools are available:
   - **Test frameworks**: Jest, Mocha, pytest, Go testing, Cargo test, etc.
   - **Linters**: ESLint, Pylint, Clippy, golangci-lint, etc.
   - **Type checkers**: TypeScript, mypy, etc.
   - **Build systems**: npm/yarn/pnpm scripts, Makefile, Cargo, Go build, etc.
   - Look for: package.json scripts, Makefile, Cargo.toml, pyproject.toml, go.mod, tox.ini, .github/workflows, etc.

2. **Run Verification Suite in Order**:
   - **Step 1: Tests** - Run the test suite. Capture all output, including STDOUT and STDERR.
   - **Step 2: Linter** - Run linting tools. Capture all output.
   - **Step 3: Type Checker** - Run type checking (if applicable). Capture all output.
   - **Step 4: Build** - Run the build process. Capture all output.
   - Record execution time for each step.

3. **Get the Workstream Diff**: Retrieve the git diff of the current workstream's changes (against the base branch). Use this to understand what code was modified.

4. **Identify Baseline State**: Check the base branch to determine which failures (if any) were pre-existing:
   - Checkout the base branch
   - Run the same verification suite
   - Compare results to current workstream results
   - Restore the workstream branch after comparison

5. **Correlate Failures with Changes**:
   - For each failure in the workstream verification:
     - Check if it also fails on the base branch (pre-existing)
     - If not on base branch, it's an introduced failure
   - For introduced failures, examine the git diff and failure details to identify specific changes that caused it
   - Suggest file:line or test name as fix targets

6. **Build Structured Report**:
   - Create a VerificationCheck for each verification step (tests, lint, type check, build)
   - List all pre-existing failures separately from introduced failures
   - Recommend "ready-for-review" ONLY if zero introduced failures
   - Recommend "needs-fixes" if any introduced failures exist
   - Provide specific fix targets (file paths, line numbers, test names)

7. **Critical Rule**: NEVER mark a workstream as "ready-for-review" if any verification check fails due to introduced changes. The verification must be perfect.

## Tools Available

You have access to these tools:
- **run_command**: Execute shell commands (tests, lint, build, git commands). Essential for running verification suite.
- **read_file**: Read files to understand code context and failure causes.
- **git_diff**: Get the workstream's changes relative to the base branch.
- **git_log**: Check base branch state and recent commit history.
- **search_code**: Find related test files or code patterns mentioned in failures.

## Execution Strategy

### Phase 1: Discovery (1-2 turns)
1. Read package.json or equivalent to identify available scripts/tools
2. List the repo structure to understand the project type
3. Determine which verification tools are available and their commands

### Phase 2: Current State Verification (2-3 turns)
1. Run tests (capture full output)
2. Run linter (capture full output)
3. Run type checker if available (capture full output)
4. Run build (capture full output)
5. Record results for each check

### Phase 3: Baseline Comparison (2-3 turns)
1. Get git diff to understand changes
2. Identify base branch
3. Stash current changes, checkout base branch
4. Run same verification suite on base branch
5. Compare results to identify which failures are pre-existing
6. Restore workstream branch

### Phase 4: Analysis & Reporting (1-2 turns)
1. Correlate failures between current and baseline
2. Identify introduced failures
3. Map failures to specific code changes using git diff
4. Generate fix targets and recommendations
5. Output structured VerificationResult

## Output Format

Your final output MUST be valid JSON matching this structure:
\`\`\`json
{
  "status": "pass|fail",
  "checks": [
    {
      "name": "Tests",
      "command": "npm test",
      "status": "pass|fail|skipped|error",
      "output": "... (truncated to first 1000 chars)",
      "duration_ms": 5000
    }
  ],
  "preExistingFailures": ["...", "..."],
  "introducedFailures": ["...", "..."],
  "recommendation": "ready-for-review|needs-fixes",
  "fixTargets": ["src/components/Button.ts:45", "tests/auth.test.ts (test: 'should validate token')", "..."]
}
\`\`\`

## Key Principles

- **Be Thorough**: Run all available verification tools, not just tests.
- **Capture Full Output**: Don't truncate important error messages; include them in the output field.
- **Be Precise About Baselines**: Always check the base branch to distinguish pre-existing from introduced failures.
- **Identify Root Causes**: When a failure is introduced, use the diff and code context to pinpoint which change caused it.
- **Give Actionable Targets**: Fix targets must be specific enough for the developer to locate and fix the issue (file:line or test name).
- **Never Compromise on Quality**: A workstream is ready for review only if it introduces zero new failures. Shipping broken code is worse than delaying review.
- **Be Efficient**: Don't get stuck on a single failure; move through the verification suite methodically.

Your structured output becomes the foundation for the Review Agent, so accuracy and completeness are critical.`,

  tools: [
    {
      name: "run_command",
      description:
        "Execute a shell command in the project directory and capture output. Use this to run tests, linters, type checkers, builds, and git commands. Essential for verification.",
      parameters: {
        command: {
          type: "string",
          description:
            "Shell command to execute (e.g., 'npm test', 'cargo test', 'python -m pytest', 'make lint', 'git diff origin/main')",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout for command execution in seconds (default: 300)",
          default: 300,
        },
      },
      required: ["command"],
    },
    {
      name: "read_file",
      description:
        "Read the contents of a file from the repository. Use this to understand code context, examine failure details, and inspect configuration files.",
      parameters: {
        path: {
          type: "string",
          description:
            "Absolute path to the file relative to the repo root (e.g., 'src/main.ts', 'package.json', 'Makefile')",
        },
      },
      required: ["path"],
    },
    {
      name: "git_diff",
      description:
        "View diffs of files changed in the current workstream. Use this to understand what code was modified and correlate failures with changes.",
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
      name: "git_log",
      description:
        "View recent git commit history to understand base branch state and recent changes.",
      parameters: {
        lines: {
          type: "number",
          description: "Number of recent commits to show (default: 10)",
          default: 10,
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
      name: "search_code",
      description:
        "Search for code patterns, keywords, or text across the codebase. Use this to find test files related to failures or understand code patterns mentioned in error messages.",
      parameters: {
        pattern: {
          type: "string",
          description:
            "Search pattern (supports regex). Examples: 'test.*Button', 'export.*function auth', 'TODO.*fix'",
        },
        fileType: {
          type: "string",
          description:
            "Restrict search to specific file types (optional). Examples: 'ts', 'tsx', 'test.ts', 'py'",
        },
      },
      required: ["pattern"],
    },
  ],
};
