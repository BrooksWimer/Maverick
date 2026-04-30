# Maverick Project Context

Maverick is the personal AI orchestration control plane for durable, Discord-driven workstreams across multiple projects.

## Durable Goal

Make AI workstreams reliable enough to use as everyday project infrastructure: Discord thread routing, epic branch lifecycle, bounded planning context, preserved state, verification, review, finish, promotion, and deploy operations should all behave predictably.

## Operating Model

- Project -> epic/thread -> disposable workstream is the canonical lifecycle.
- Every git-backed workstream must resolve a configured epic before a worktree is created.
- A Discord thread slug should match the configured epic id.
- Workstreams branch from epics, finish back into epics, and only explicit lane/epic promotion reaches production.
- Stored workstream state, turns, reports, planning context, verification context, and events are durable history and must not be deleted during cleanup.

## Planning Context Rules

- Prefer deterministic context bundles and stored state over fresh repo sweeps.
- Planning agents receive project context, epic context, AGENTS doctrine, recent relevant state, changed evidence, and operator instruction.
- If fingerprints are unchanged, reuse the existing model where possible.
- If fingerprints changed, update only model sections affected by the changed evidence.
- Agents may request broader inspection only with exact paths or search patterns and a concrete reason.

## Current Priorities

- Reliable Discord command UX and repair guidance.
- Epic-first branch routing and lifecycle.
- Claude planning cost control and resumable checkpoints.
- Windows/Linux deployment health and shared state safety.
- Worktree cleanup that never deletes durable branches or history.

## TODO

- Add deeper diagrams for cross-host runtime ownership after the state-sync work settles.
- Add a concise operator runbook for restarting Windows and Linux bots.
