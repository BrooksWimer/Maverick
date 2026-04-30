# Epic: git-hygiene

Owns branch policy, worktree safety, bootstrap doctrine, cleanup, and repository hygiene for Maverick-managed projects.

## Scope

- Epic branch audit and repair.
- Worktree provisioning and recovery.
- Finish cleanup of disposable branches/worktrees after safe merge evidence exists.
- Bootstrap doctrine and AGENTS/skills consistency.

## Boundaries

- Production promotion behavior belongs jointly with `control-plane`.
- Live service restart behavior belongs in `deployment-ops`.

## Planning Guidance

- Never delete durable epic branches.
- Never delete workstream DB history, turns, reports, planning context, verification context, or event logs.
- Existing active workstreams should be preserved during migrations.
