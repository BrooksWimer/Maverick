# Feature: Autonomous Decision Queue

**Status:** Specified, ready to implement
**Depends on:** Claude Code adapter (see `claude-integration-plan.md`)
**Branch to create:** `feature/decision-queue`
**Estimated scope:** Medium — new module + orchestrator hooks + Discord UI

---

## Problem

Maverick currently requires the operator to pull context from memory, decide what to do next, and type a dispatch command. This means work only flows when the operator is actively thinking about it. Between sessions there is no forward momentum, and resuming requires re-reading turn output, git state, and notes to figure out where things stand.

## Solution

An autonomous work loop where every workstream is always in one of three states:

- **Running** — Codex is executing a turn. No action needed.
- **Queued** — A defined next task is waiting. It auto-starts when resources are available.
- **Awaiting decisions** — Work is blocked on choices only the operator can make. Those choices are presented as structured Discord polls with Claude-generated options.

Claude is the engine that keeps this loop moving. After every Codex turn completes, Claude analyzes the outcome and determines: is there a clear next step (queue it), or are there decisions needed (present them)?

## How It Works

### The Loop

```
Codex turn completes
  → Claude reads: turn output, git diff, epic charter, workstream history
  → Claude determines: next step clear? or decisions needed?

  If next step is clear:
    → Claude generates a dispatch instruction
    → Instruction enters the run queue
    → Auto-advances when a slot is available

  If decisions are needed:
    → Claude generates 2-4 concrete options per decision
    → Options posted as Discord polls in the workstream channel
    → One option is always "I need to think about this more"
    → Operator picks an option (or writes free text)
    → Answer feeds back into Maverick as dispatch parameters
    → Workstream moves to queued
```

### The Run Queue

A per-project ordered queue of workstreams ready to execute. Controlled by the existing `maxConcurrentWorkstreams` config.

- When a running workstream finishes its turn and auto-advances, it re-enters the queue.
- When a workstream moves from "awaiting decisions" to "queued" (operator answered), it enters the queue.
- The queue drains automatically. No operator intervention for queued items.
- Manual dispatch still works — it bypasses the queue and runs immediately.

### Decision Presentation

For quick operational decisions (which approach, scope choice, priority call):
- Discord polls with 2-4 Claude-generated options
- Always includes an escape hatch option: "I need to discuss this"
- Poll answers map to concrete dispatch instructions or config changes

For complex strategic decisions (V2, deferred):
- The "I need to discuss this" option opens a Discord forum post
- Forum post contains Claude's full analysis as the opening message
- Operator has a free-form conversation in the thread
- When resolved, operator marks the decision and it feeds back into the queue

### What Claude Receives for Analysis

After each Codex turn, Claude gets a structured context payload:

```
- Codex turn output and status
- Git diff from the turn
- Current workstream state and history (recent turns)
- Epic charter context (if present)
- AGENTS.md and relevant project docs
- Recent assistant notes tagged to this project
- Current git status (dirty files, unpushed commits)
- Pending approvals
```

Claude is asked to produce:

```json
{
  "assessment": "What happened and what state the workstream is in",
  "nextStepClear": true | false,
  "nextStep": {
    "instruction": "The dispatch instruction if next step is clear",
    "confidence": 0.0-1.0,
    "reasoning": "Why this is the right next step"
  },
  "decisions": [
    {
      "question": "What the operator needs to decide",
      "context": "Why this decision matters now",
      "options": [
        { "label": "Option A", "description": "What this means", "dispatchInstruction": "..." },
        { "label": "Option B", "description": "What this means", "dispatchInstruction": "..." },
        { "label": "I need to think about this", "description": "Defer this decision", "defer": true }
      ]
    }
  ],
  "hygieneAlerts": ["Uncommitted changes in src/foo.ts", "3 pending approvals"]
}
```

## New Components

### `src/queue/`

- `run-queue.ts` — Per-project ordered queue with concurrency control. Drains automatically. Entries are workstream IDs with queued instructions.
- `decision-engine.ts` — After a turn completes, dispatches context to Claude adapter, parses the structured response, routes to queue or decisions.
- `types.ts` — Queue entry, decision, option, and analysis types.

### Changes to Existing Files

- `orchestrator.ts` — Hook `decision-engine` into the turn completion flow. Add queue drain loop. Add methods: `queueWorkstream()`, `getQueueState()`, `resolveDecision()`.
- `config/schema.ts` — Add `decisionQueue` config section (enabled, auto-advance, Claude model for analysis).
- `discord/bot.ts` — Add poll creation for decisions. Add poll result listener that feeds answers back to `resolveDecision()`. Add `/maverick queue` command to view queue state.
- `state/database.ts` + `schema.sql` — Add `decision_queue` and `pending_decisions` tables.

### Config Addition

```typescript
decisionQueue: z.object({
  enabled: z.boolean().default(false),
  autoAdvance: z.boolean().default(true),
  requireConfirmationAboveConfidence: z.number().default(0.85),
  claudeModel: z.string().default("sonnet"),
  maxQueueDepth: z.number().default(10),
}).optional()
```

The `requireConfirmationAboveConfidence` threshold means: if Claude is very confident about the next step, auto-queue it. If confidence is below the threshold, present it as a decision even if Claude thinks the next step is "clear." This lets the operator tune how autonomous the system is.

## Discord UX

### Poll Format

```
📋 Decision needed for workstream `wifi-scanner-auth`

**How should we handle the OAuth token refresh?**

The current implementation stores tokens in memory, which means they're lost on restart.
This needs to be resolved before the auth flow is complete.

🔵 Store in SQLite alongside session data
🟢 Store in the system keychain via keytar
🟡 Store encrypted on disk in the project config
🔴 I need to think about this more

Poll expires in 24 hours. Pick the approach that fits best,
or select the last option to defer.
```

### Queue Status (`/maverick queue`)

```
Run Queue:
  🟢 Running (2/3 slots):
    • wifi-scanner-auth — implementing OAuth token storage
    • maverick-daily-brief — writing brief collector

  ⏳ Queued (1):
    • netwise-admin — add route validation (confidence: 0.92)

  🔴 Awaiting decisions (1):
    • wifi-scanner-ble — 2 pending decisions (posted 3h ago)
```

## Implementation Sequence

1. **Run queue** — The data structure and drain loop. Test with manual `queueWorkstream()` calls. No Claude yet.
2. **Decision engine** — Claude analyzes turn outcomes, produces structured output. Wire into turn completion.
3. **Discord polls** — Create polls from decisions, listen for answers, feed back to queue.
4. **Auto-advance** — Close the loop: turn completes → Claude analyzes → queue or poll → next turn starts.
5. **(V2) Forum discussions** — For decisions that hit "I need to think about this," open a Discord forum post with Claude's full analysis. Free-form conversation. Resolution feeds back to queue.

## Design Decisions

**Why polls, not buttons?** Polls allow more than 2 options, show results, and have a natural expiration. Buttons are binary (approve/deny) and don't accommodate nuanced choices with descriptions.

**Why auto-advance by default?** The whole point is reducing operator overhead. If Claude is confident and the next step is clear, the operator shouldn't have to click "go." The confidence threshold is the safety valve.

**Why defer forum discussions to V2?** The poll + escape hatch covers the common case. Forum integration requires a new channel type, new permissions, and a new interaction pattern. Better to ship the core loop first and add the discussion layer once real usage shows which decisions need it.

**Why not replace manual dispatch?** Manual dispatch is the escape hatch. The operator should always be able to bypass the queue and say "do this now." The decision queue layers on top — it's the default mode, not the only mode.
