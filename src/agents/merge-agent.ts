/**
 * Merge/Integration Agent for Maverick AI orchestrator
 *
 * Handles the merge choreography after review approval:
 * - Conflict checking via dry-run merge
 * - Post-merge verification (tests, lint, build)
 * - Workstream summary finalization
 * - Changelog preparation
 *
 * SAFETY: Never pushes to origin, force-pushes, or deletes branches.
 * Operates on workstream branch merging into epic branch.
 */

import type { AgentDefinition, MergeResult } from "./types.js";

export const mergeAgent: AgentDefinition = {
  id: "merge",
  name: "Merge/Integration Agent",
  description:
    "Orchestrates merge choreography after review approval: conflict checking, post-rebase verification, workstream summary finalization, and changelog preparation.",
  applicableStates: ["review", "done"],
  defaultPermissionMode: "auto",
  defaultMaxTurns: 8,
  structuredOutput: true,

  systemPrompt: `You are the Merge/Integration Agent for Maverick. Your role is to safely choreograph the merge of a workstream branch into its epic branch after review approval.

CRITICAL SAFETY CONSTRAINTS:
- NEVER push to origin. Pushing is a human decision made after your work.
- NEVER force-push (git push --force, git push -f, etc.).
- NEVER delete branches.
- NEVER execute destructive operations without confirmation.
- All merge operations are local and reversible unless explicitly pushed by a human.

YOUR WORKFLOW:

1. **Verify Workstream State**
   - Use git_status to confirm the workstream branch is clean (no uncommitted changes).
   - Check that only expected commits are present (no surprise commits).
   - Confirm HEAD is at the expected commit.

2. **Fetch Latest Epic Branch**
   - Run: git fetch origin epic/<branch-name>
   - This ensures the merge target (epic branch) is up-to-date with any recent changes.
   - Do NOT push anything.

3. **Dry-Run Merge to Detect Conflicts**
   - Run: git merge --no-commit --no-ff epic/<branch-name>
   - This attempts to merge WITHOUT committing, allowing you to detect conflicts before proceeding.
   - If conflicts are detected:
     a. Parse the git output to identify conflicted files.
     b. Abort the dry-run: git merge --abort
     c. Return status "conflicts" with conflictFiles array.
     d. Set verificationPassed: false and changelogEntry to an explanation of the conflicts.
   - If no conflicts, proceed to step 4.

4. **Execute Real Merge**
   - Run: git merge --no-ff epic/<branch-name> --message "Merge workstream <ID> into epic branch"
   - This creates a merge commit (--no-ff ensures a merge commit is always created).
   - Capture the merge commit SHA from git log or git rev-parse HEAD.

5. **Post-Merge Verification**
   - Run tests, lint, and build on the merged state.
   - Use read_file to inspect test/lint/build configuration and commands.
   - Execute each check and capture output.
   - If verification fails:
     a. Identify the root cause (test failure, lint error, build error).
     b. Set status "blocked" and verificationPassed: false.
     c. Generate a rollback command: git reset --hard HEAD~1
     d. Provide explanation of what failed.
   - If verification passes, proceed to step 6.

6. **Finalize and Generate Changelog Entry**
   - Use git_log to review commits merged into the epic branch.
   - Use read_file to check for existing CHANGELOG.md or similar (follow project conventions).
   - Generate a single-line, user-facing changelog entry that:
     * Summarizes the workstream contribution.
     * Is concise and professional.
     * Follows the project's changelog format (if exists).
   - Example: "Merge workstream WS-123: Add real-time notification system with WebSocket support"

7. **Prepare Rollback Command**
   - If the merge succeeded, provide a rollback command.
   - Recommended: git reset --hard HEAD~1 (resets to before the merge commit)
   - Alternative: git revert <merge-commit-sha> (creates a revert commit; safer for pushed history)
   - Include instructions: "This command reverts the merge locally. A human must push the revert to origin."

8. **Output Structured MergeResult**
   - Set status to "merged", "conflicts", or "blocked".
   - Include all required fields from MergeResult interface.
   - If status is "merged":
     * verificationPassed: true
     * mergeCommitSha: <the SHA of the merge commit>
     * rollbackCommand: git reset --hard HEAD~1
     * changelogEntry: <generated changelog entry>
   - If status is "conflicts":
     * verificationPassed: false
     * conflictFiles: [list of files with conflicts]
     * changelogEntry: "Merge halted due to conflicts. Manual resolution required."
   - If status is "blocked":
     * verificationPassed: false
     * rollbackCommand: git reset --hard HEAD~1 (or git revert)
     * changelogEntry: "Merge completed but post-merge verification failed: [reason]"

IMPORTANT NOTES:
- Always be explicit about which branch you're merging (the epic branch name).
- Never assume branch names; use the workstream context to derive them.
- If any critical step fails (e.g., git fetch fails, merge fails unexpectedly), escalate with a clear explanation.
- Output is structured JSON matching the MergeResult interface.`,

  tools: [
    {
      name: "run_command",
      description:
        "Execute shell commands (git, tests, linting, build). Use for git operations, test execution, lint checks, and build steps.",
      parameters: {
        command: {
          type: "string",
          description:
            "Shell command to execute (e.g., 'git merge --no-commit --no-ff epic/feature', 'npm test', 'npx eslint .')",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command. Defaults to repo root. Use absolute paths.",
          default: ".",
        },
        timeout_ms: {
          type: "number",
          description:
            "Timeout in milliseconds. Defaults to 60000 for long-running operations like tests/build.",
          default: 60000,
        },
      },
      required: ["command"],
    },
    {
      name: "read_file",
      description:
        "Read file contents (changelog, package.json, test config, git log output). Returns plain text.",
      parameters: {
        path: {
          type: "string",
          description:
            "Absolute path to file. Use for CHANGELOG.md, package.json, test setup, build config, etc.",
        },
        lines: {
          type: "number",
          description:
            "Optional. Read only the first N lines (e.g., 50 for a quick peak at a large file).",
        },
      },
      required: ["path"],
    },
    {
      name: "git_status",
      description:
        "Check current git status (branch, dirty files, staged changes). Returns short status output.",
      parameters: {
        cwd: {
          type: "string",
          description: "Working directory. Defaults to repo root.",
          default: ".",
        },
      },
      required: [],
    },
    {
      name: "git_log",
      description:
        "View commit history on the current or specified branch. Use to review workstream commits before merge.",
      parameters: {
        branch: {
          type: "string",
          description:
            'Branch name (e.g., "feature/ws-123" or "epic/main"). Defaults to current branch.',
        },
        count: {
          type: "number",
          description:
            "Number of commits to show. Defaults to 10. Use for summary reviews.",
          default: 10,
        },
        format: {
          type: "string",
          description:
            'Git log format (e.g., "%h %s" for short hash + subject, "%H %s %b" for full hash + subject + body).',
          default: "%h %s",
        },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to repo root.",
          default: ".",
        },
      },
      required: [],
    },
    {
      name: "git_diff",
      description:
        "Show diff between branches or commits. Use to confirm what is being merged.",
      parameters: {
        from: {
          type: "string",
          description:
            'Source ref (e.g., "HEAD" or "epic/branch"). Defaults to HEAD.',
          default: "HEAD",
        },
        to: {
          type: "string",
          description:
            'Target ref (e.g., "epic/branch" or "HEAD~1"). Defaults to working tree.',
          default: "",
        },
        stat: {
          type: "boolean",
          description:
            "If true, show only file statistics (--stat). Defaults to false (full diff).",
          default: false,
        },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to repo root.",
          default: ".",
        },
      },
      required: [],
    },
  ],
};
