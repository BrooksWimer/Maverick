# Claude Integration

## Phase 1

Phase 1 adds the Claude CLI adapter and the nightly brief path without changing how existing Codex workstreams execute.

### New config

`defaults.executionBackend` or any project `executionBackend` can now use:

```json
{
  "type": "claude-code",
  "model": "sonnet",
  "claudePath": "claude",
  "permissionMode": "plan",
  "maxTurns": 10
}
```

Top-level brief config:

```json
{
  "brief": {
    "enabled": true,
    "schedule": "0 8 * * *",
    "discordChannelId": "1234567890",
    "storagePath": "./data/briefs",
    "model": "sonnet"
  }
}
```

### Runtime behavior

- `/maverick brief` generates a Claude brief on demand, posts it to the configured channel or invoking channel, and saves Markdown under `brief.storagePath`.
- If `brief.enabled` and `brief.schedule` are set, Maverick runs the brief automatically on the configured cron minute in `assistant.timeZone`.
- Brief context includes project workstreams, git status and recent commits, pending approvals, tagged notes, reminders, and upcoming calendar items.

### Notes

- Claude utility tasks use `CLAUDE_PATH` or `claude` on `PATH` when no `claude-code` backend is configured in the control plane.
- Planning, review, and brief generation now route through `src/agents` as the orchestration-facing cognition layer. `src/claude` remains the lower-level Claude runtime/transport layer.
- Phase 2 adds Claude post-turn review with per-project config:

```json
{
  "claudeReview": {
    "enabled": true,
    "autoAfterTurn": true,
    "model": "sonnet"
  }
}
```

- `/workstream review --claude` runs the Claude reviewer on demand without changing the existing default review command.
- When `claudeReview.autoAfterTurn` is enabled on a project that still runs Codex as the primary backend, Maverick triggers a Claude review after each completed Codex turn and posts the result to Discord.
- Phase 3 adds Claude planning with per-project config:

```json
{
  "claudePlanning": {
    "enabled": true,
    "autoOnPlanningState": true,
    "model": "sonnet"
  }
}
```

- `/workstream plan` now stores structured decision-gated planning context on the workstream, not only a plan blob.
- Fresh planning runs a live `intake -> goal-framing -> modeling -> test-design -> planning` sequence through `src/agents`, then persists the scoped intake, goal frame, system model, and test design so resume flows can reuse them.
- When planning still needs operator input, Maverick also runs an `operator-feedback` agent to build a better questionnaire and a `response-formatting` agent to produce Discord-friendly Markdown from the stored planning state.
- If planning needs operator input, Maverick records the pending questions, posts them in Discord for auto-generated plans, and accepts answers through `/workstream answer-plan` using `question-id: answer` lines.
- Once the questions are resolved, Maverick stores the final Codex execution prompt on the workstream, and it only claims dispatch readiness when that real `finalExecutionPrompt` exists.
- If the next `/workstream dispatch` uses the same instruction as the stored planning goal, Maverick reuses the stored final execution prompt automatically.
- If `claudePlanning.autoOnPlanningState` is enabled, Maverick generates a plan when the workstream enters the `planning` state.
- Claude review now also inherits any stored planning system model and test design from the workstream context.
- For epic-bound workstreams, Maverick also runs the `epic-context` agent so planning and Claude review can inherit dynamic sibling-workstream context in addition to the static epic charter.
- Planning now uses an explicit `awaiting-decisions` workflow state when operator answers are still required, and Maverick returns to `planning` after those answers are merged back into the stored planning flow.
- Dispatching from a ready plan now advances the workstream into `implementation`, so the downstream verification loop can operate on a coherent state path instead of leaving workstreams stuck in `planning`.
- Phase 4 adds Claude verification with per-project config:

```json
{
  "claudeVerification": {
    "enabled": true,
    "autoAfterTurn": true,
    "model": "sonnet"
  }
}
```

- `/workstream verify` runs the verification agent on demand, stores a structured verification report on the workstream, and includes that report in later Claude reviews.
- When `claudeVerification.autoAfterTurn` is enabled for a Codex-backed project, Maverick now runs `implementation -> verification -> review|implementation` automatically after each completed turn.
- Failed verification runs the `incident-triage` agent automatically for introduced failures, stores the triage result on the verification record, and seeds the next implementation goal from the diagnosed fix when escalation is not required.
- Discord status and notification flows now surface stored verification status alongside planning readiness instead of hiding that state inside raw JSON.
