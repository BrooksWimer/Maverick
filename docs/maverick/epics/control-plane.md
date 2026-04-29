# Epic: control-plane

Owns Maverick's core orchestration behavior: workstream state, state persistence, planning checkpoints, lifecycle transitions, audit/repair surfaces, and execution routing.

## Scope

- Workstream creation, dispatch, verification, review, finish, cleanup, and promotion orchestration.
- Durable planning and verification state.
- Epic-first config normalization and stale state repair.
- API surfaces that expose lifecycle behavior.

## Boundaries

- Discord-specific rendering belongs in `discord-routing`.
- Host restart/deploy work belongs in `deployment-ops`.
- Local branch/worktree policy belongs in `git-hygiene` unless it changes orchestrator lifecycle semantics.

## Planning Guidance

- Reuse existing state tables and planning context fields before adding new storage.
- Preserve backwards compatibility for existing workstreams while making new workstreams epic-required.
- Prefer checkpointed progress over all-or-nothing background operations.
