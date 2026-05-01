# Maverick Feature Plans

Historical feature plans for Maverick. The current operator-facing runtime docs live in `../maverick/RUNBOOK.md`, `../maverick/PROJECT_CONTEXT.md`, and `../claude-integration.md`.

## Implementation Order

### 1. Stabilization (do first)
**File:** `../maverick-stabilization-review-2026-04-06.md` (in repo root)
Four small hardening fixes (~45 lines total). HTTP port-conflict handling, shutdown resilience, Codex process recovery, stderr warning visibility. Do these before any new feature work.

### 2. Claude Code Adapter
**File:** `claude-integration-plan.md`
**Branch:** `feature/claude-integration` (to be created)
Adds Claude Code CLI as a new execution backend alongside Codex. Enables post-turn code review and pre-dispatch planning.

### 3. Decision-Gated Workstream Planning
**File:** `decision-gated-planning-spec.md`
**Branch:** `feature/decision-gated-planning` (to be created)
**Depends on:** Claude Code adapter (#2)
Upgrades `/workstream plan` from a passive plan blob into a structured decision-gated planning flow. Claude identifies the best next slice, surfaces only the key missing facts and high-ramification decisions, stores that planning state on the workstream, and then uses operator answers to synthesize the final Codex execution prompt.

