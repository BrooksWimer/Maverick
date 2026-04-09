# Claude Integration Plan for Maverick

## The Core Idea

Codex is Maverick's hands — it implements, runs commands, edits files. Claude becomes Maverick's second opinion — it reviews, plans, synthesizes, and catches things Codex misses. They don't replace each other; they complement each other in the same orchestration flow.

## How It Fits Into What Already Exists

Maverick already has three execution backends: `codex-app-server` (full-featured), `codex-cli` (subprocess, simpler), and `mock` (testing). The `CodexCliAdapter` is the direct template for a Claude adapter — it spawns a subprocess, captures output, and maps results to the same `ExecutionBackendAdapter` interface.

Claude Code CLI supports exactly the mode we need: `claude -p --output-format stream-json` runs a single task, streams structured JSON output, and exits. It can be given a system prompt, a working directory, and additional directories to read. It supports `--max-turns` to bound agent loops and `--permission-mode` to control what it can do autonomously.

## What Claude Should Do Inside Maverick

Claude serves three roles, each triggered differently:

### Role 1: Post-Turn Reviewer

After Codex finishes a turn, Maverick optionally asks Claude to review what changed. Claude reads the diff, the turn output, and the workstream context, then produces a structured assessment: what looks good, what looks risky, what Codex might have missed.

**When it triggers:** Configurable per-project. A new field `claudeReview` on the project config controls whether reviews happen automatically after every turn, only on request, or never.

**What Maverick sends Claude:**
- The git diff from the turn
- The Codex turn output/summary
- The original instruction
- The epic charter context (if present)
- A system prompt that says "You are reviewing another agent's implementation. Be specific about risks and missed edge cases."

**What Maverick gets back:** A structured review (findings, severity, suggestions) that maps directly to the existing `ReviewResult` type.

**Value:** You stop being the only reviewer. Codex implements, Claude audits, you make the final call.

### Role 2: Pre-Dispatch Planner

Before sending a complex task to Codex, Maverick asks Claude to analyze the codebase and write a focused implementation plan. That plan becomes part of the instruction Codex receives.

**When it triggers:** Manually, via a new Discord command (`/workstream plan`) or a flag on dispatch (`/workstream dispatch instruction:... --plan`). Could also be automatic for workstreams in the "planning" state.

**What Maverick sends Claude:**
- The user's high-level instruction
- The project's AGENTS.md and relevant codebase context
- Recent turn history for the workstream
- A system prompt that says "Write a concrete implementation plan. Specify which files to modify, what changes to make, and what to test. The plan will be handed to another agent for execution."

**What Maverick gets back:** A text plan that gets prepended to the Codex dispatch instruction, similar to how epic charter context is injected today.

**Value:** Codex executes better with a clear plan. Claude's strength is reading a large codebase and identifying the right approach; Codex's strength is executing that approach step by step.

### Role 3: Nightly Brief Synthesizer

The daily summary feature we discussed. Claude reads across all project state — workstreams, turns, git logs, notes, reminders — and produces the nightly operating brief.

**When it triggers:** On a schedule (cron or Maverick's own timer), or on demand via `/maverick brief`.

**What Maverick sends Claude:**
- A structured context dump (JSON) of all project states, recent activity, pending items
- Git status and recent log for each project repo
- Recent assistant notes and upcoming reminders
- A system prompt that says "Synthesize this into a concise daily brief. Lead with what matters most. Flag anything that needs attention."

**What Maverick gets back:** A formatted brief that gets posted to a configured Discord channel and saved as a Markdown file.

**Value:** This is the feature that turns Maverick from a dispatch tool into a daily operating system.

## Architecture

### New Files

```
src/claude/
  claude-adapter.ts    # ClaudeCliAdapter implementing ExecutionBackendAdapter
  types.ts             # Claude-specific types (review config, brief config)
  context-builder.ts   # Builds context payloads for each role
  brief-collector.ts   # Gathers cross-project state for nightly brief
  brief-renderer.ts    # Turns collected state into the brief prompt
```

### The Adapter

`ClaudeCliAdapter` follows the same pattern as `CodexCliAdapter`:

```typescript
class ClaudeCliAdapter implements ExecutionBackendAdapter {
  readonly name = "claude-code";

  // Spawns: claude -p --output-format stream-json
  //         --system-prompt-file <path>
  //         --max-turns <N>
  //         --permission-mode <mode>
  //         --add-dir <additional dirs>
  //
  // Working directory set to the project repo or worktree.
  // Streams NDJSON output, emits partial content via outputCallbacks.
  // Maps completion to TurnResult.
}
```

Key differences from the Codex CLI adapter:
- Uses `--output-format stream-json` for structured streaming (Codex CLI just captured raw stdout)
- Uses `--permission-mode plan` by default for review/planning tasks (Claude reads but doesn't modify)
- Uses `--permission-mode auto` for the nightly brief (needs to run git commands)
- Supports `--system-prompt-file` to inject role-specific prompts
- Supports `--add-dir` to give Claude visibility into multiple project repos for cross-project tasks
- Supports `--max-turns` to bound agent loops (reviews should be 1-3 turns, briefs maybe 5-10)

### Config Changes

Add to `config/schema.ts`:

```typescript
// New execution backend variant
z.object({
  type: z.literal("claude-code"),
  model: z.string().default("sonnet"),
  claudePath: z.string().optional(),  // path to claude binary
  permissionMode: z.enum(["plan", "auto", "default"]).default("plan"),
  maxTurns: z.number().int().min(1).max(50).default(10),
})

// New project-level config
claudeReview: z.object({
  enabled: z.boolean().default(false),
  autoAfterTurn: z.boolean().default(false),  // review every Codex turn
  model: z.string().optional(),
}).optional()

// New top-level config
brief: z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().optional(),  // cron expression
  discordChannelId: z.string().optional(),
  storagePath: z.string().optional(),  // where to save markdown briefs
  model: z.string().optional(),
}).optional()
```

### How the Three Roles Wire In

**Post-turn review** hooks into `orchestrator.ts` after a Codex turn completes:
```
turn.completed → if project.claudeReview.autoAfterTurn →
  build review context → dispatch to Claude adapter →
  emit review.completed event → post to Discord
```

**Pre-dispatch planning** adds a step before Codex dispatch:
```
user requests plan → dispatch to Claude adapter with planner prompt →
  Claude returns plan → store plan on workstream →
  user dispatches → plan prepended to Codex instruction (like epic charter)
```

**Nightly brief** runs as a scheduled job:
```
timer fires → brief-collector gathers state from all projects →
  context-builder assembles the prompt →
  dispatch to Claude adapter with brief prompt →
  brief-renderer formats output → post to Discord + save markdown
```

### Context Building (the critical piece)

The context builder is what makes this trustworthy rather than vague. For each role, it constructs a *data-first* payload:

**Review context:**
```
- git diff (the actual changes)
- Codex turn output (what it said it did)
- original instruction
- epic charter (if any)
- relevant test results
```

**Planning context:**
```
- user instruction
- AGENTS.md content
- directory tree of relevant paths
- recent turn history
- epic charter (if any)
```

**Brief context:**
```
For each project:
  - workstream states and recent turn summaries
  - git log --oneline --since="24 hours ago" (or last brief)
  - git status (dirty files, unpushed commits)
  - pending approvals
  - recent assistant notes tagged to this project
Across all projects:
  - upcoming reminders
  - recent general notes
  - calendar events (if enabled)
```

Claude receives structured data and is asked to synthesize it. It doesn't have to guess or hallucinate what happened — the evidence is in the prompt.

## Sequencing

### Phase 1: Claude adapter + nightly brief (ship first)

This is the highest-value, lowest-risk integration. The adapter is a straightforward subprocess wrapper. The brief collector queries existing data stores. The output is a Discord message and a saved file. Nothing changes about how Codex works.

Deliverables:
- `ClaudeCliAdapter` implementing `ExecutionBackendAdapter`
- `claude-code` variant in `ExecutionBackendSchema`
- `brief-collector.ts` + `brief-renderer.ts`
- `/maverick brief` Discord command (manual trigger)
- Scheduled trigger (cron or interval)
- Brief posted to configured Discord channel + saved to storage path

### Phase 2: Post-turn review

Hook the review into the turn completion flow. This is where the two agents start genuinely collaborating — Codex builds, Claude checks.

Deliverables:
- `claudeReview` config on projects
- Review context builder
- Auto-trigger after Codex turns (configurable)
- `/workstream review --claude` command for manual trigger
- Review results posted to Discord alongside Codex turn summary

### Phase 3: Pre-dispatch planning

This is the most architecturally interesting but least urgent. It changes the dispatch flow from "user → Codex" to "user → Claude (plan) → Codex (execute)."

Deliverables:
- `/workstream plan` command
- Plan storage on workstream record
- Plan injection into Codex dispatch (parallel to epic charter injection)
- Optional auto-plan for workstreams entering "planning" state

## What This Unlocks

Once Claude is in the loop, you have a genuine two-agent system:

- **Codex implements.** Claude reviews. You approve. Three perspectives on every change.
- **Claude plans.** Codex executes. The plan constrains Codex to a thought-through approach rather than ad-hoc exploration.
- **Claude synthesizes.** Every morning you open Discord and see a brief written by an agent that actually read the git logs, the turn outcomes, the notes, and the approvals. Not a guess — a report grounded in real state.
- **The nightly brief becomes the bridge to ChatGPT.** Save the brief as Markdown, sync to Google Drive, and ChatGPT can read it conversationally. Claude wrote it from real data, so the conversational layer starts from truth rather than your memory of what happened.

The key insight is that Claude doesn't need to be a second Codex. It needs to be the analyst that makes the whole system smarter.
