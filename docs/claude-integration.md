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

- `/workstream plan` stores a Claude-authored implementation plan on the workstream.
- If the next `/workstream dispatch` uses the same instruction as the stored workstream goal, Maverick prepends the stored plan to the execution instruction automatically.
- If `claudePlanning.autoOnPlanningState` is enabled, Maverick generates a plan when the workstream enters the `planning` state.
