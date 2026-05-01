# Claude Utility Agents

Maverick uses Claude for bounded utility work around the primary Codex execution loop: planning, verification, review, epic context synthesis, incident triage, and merge guidance.

## Active Shape

- The live planning path is a single `planning` agent call. That agent performs intake-quality scoping inside the same call instead of chaining separate goal-framing, modeling, test-design, feedback, or formatting agents.
- Planning receives a deterministic context bundle: `docs/maverick/PROJECT_CONTEXT.md`, `docs/maverick/PROJECT_MEMORY.md`, epic context docs, `AGENTS.md`, recent relevant state, changed-file evidence, and the operator request.
- The context bundle stores a fingerprint. Resume flows can see what changed instead of sweeping the whole repo again.
- Claude verification and review run as utility agents and store structured reports on the workstream for Discord status, follow-up planning, and audit history.
- Incident triage runs only after failed verification when Maverick needs a repair-oriented diagnosis.

## Config

Project-level planning, verification, and review are controlled with:

```json
{
  "claudePlanning": {
    "enabled": true,
    "autoOnPlanningState": true,
    "model": "sonnet"
  },
  "claudeVerification": {
    "enabled": true,
    "autoAfterTurn": true,
    "model": "sonnet"
  },
  "claudeReview": {
    "enabled": true,
    "autoAfterTurn": true,
    "model": "sonnet"
  }
}
```

`claudePlanning.routing` can map logical profiles (`cheap`, `default`, `deep`) to Claude model names and assign profiles to `planning` and `epicContext`.

## Operator Flow

- `/workstream plan` stores structured decision-gated planning context.
- If planning needs input, Discord posts the exact question ids and answer buttons. `/workstream answer-plan` resumes the same planning thread with `question-id: answer` lines.
- When planning has a final execution prompt, action buttons and `/workstream dispatch` can run the next slice.
- `/workstream verify` stores verification context. Passing auto-verification may finish a disposable workstream into its durable lane branch.
- `/workstream review --claude` runs Claude review on demand.

## Removed Paths

The nightly/daily brief feature, Codex CLI backend, `/work` command tree, decision queue, and the extra planning-adjacent agents were intentionally removed during the stabilization cut. Durable project memory now lives in `PROJECT_MEMORY.md`, and operator-facing recovery lives in `/workstream repair`.
