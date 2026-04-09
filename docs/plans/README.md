# Maverick Feature Plans

Planned features for Maverick, in implementation order. Each plan is self-contained and specifies its dependencies.

## Implementation Order

### 1. Stabilization (do first)
**File:** `../maverick-stabilization-review-2026-04-06.md` (in repo root)
Four small hardening fixes (~45 lines total). HTTP port-conflict handling, shutdown resilience, Codex process recovery, stderr warning visibility. Do these before any new feature work.

### 2. Claude Code Adapter + Nightly Brief
**File:** `claude-integration-plan.md`
**Branch:** `feature/claude-integration` (to be created)
Adds Claude Code CLI as a new execution backend alongside Codex. First consumer is the nightly brief — Claude reads across all project state and produces a daily operating summary in Discord. Also enables post-turn code review and pre-dispatch planning.

### 3. Decision-Gated Workstream Planning
**File:** `decision-gated-planning-spec.md`
**Branch:** `feature/decision-gated-planning` (to be created)
**Depends on:** Claude Code adapter (#2)
Upgrades `/workstream plan` from a passive plan blob into a structured decision-gated planning flow. Claude identifies the best next slice, surfaces only the key missing facts and high-ramification decisions, stores that planning state on the workstream, and then uses operator answers to synthesize the final Codex execution prompt.

### 4. Autonomous Decision Queue
**File:** `decision-queue-feature-spec.md`
**Branch:** `feature/decision-queue` (to be created)
**Depends on:** Claude Code adapter (#2) and decision-gated planning (#3)
Inverts Maverick's workflow from command-driven to decision-driven. Every workstream is always running, queued, or awaiting decisions. Claude analyzes turn outcomes and either auto-queues the next step or presents structured decisions as Discord polls. V2 adds forum-based discussions for complex decisions.
