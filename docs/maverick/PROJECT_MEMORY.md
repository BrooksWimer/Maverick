# Project Memory

Durable cross-workstream facts, decisions, conventions, blockers, and completion notes recorded by Maverick.

## 2026-04-30 - Stabilization Roadmap

- Decision: planning should run as one cached Claude planning call per plan or resume, with request scoping folded into the planning prompt.
- Decision: PROJECT_MEMORY.md is the durable, operator-editable memory surface that future planning calls read before execution.
- Decision: the removed daily brief, work notes, and mirror subsystems should not be rebuilt as isolated side channels; future summaries should read from project memory plus recent state.

## 2026-04-30 - Roadmap Completion Pass

- Phase 0 cleanup removed unused agents, daily/brief paths, Codex CLI, `/work`, and stale decision-queue implementation hooks.
- Planning now uses one Claude planning call with project context, project memory, epic context, AGENTS doctrine, recent state, and changed evidence.
- Discord now has `/workstream repair` commands, action buttons, live status messages, and DM fallback for inaccessible channels.
- Workstreams have a default $5 budget guardrail with reservations before paid planning, implementation, verification, and review work.
- Linux/server vs Windows/client role selection is controlled by `MAVERICK_ROLE`; only the server role owns Discord, reminder workers, and worktree reaping.
