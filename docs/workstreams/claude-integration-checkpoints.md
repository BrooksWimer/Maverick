# Claude Integration Checkpoints

## Intake Summary

- 2026-04-08T15:45:27.7461633-04:00 `C:\Users\wimer\Desktop\Maverick\docs\plans\claude-integration-plan.md`
  Scoped the work into three phases: nightly brief first, post-turn review second, pre-dispatch planning third.
- 2026-04-08T15:45:27.7461633-04:00 `C:\Users\wimer\Desktop\Maverick\.generated\worktrees\maverick\maverick\implement-the-claude-integration-plan-in-staged-checkpoints-with-verification-after-each-phase-6afa4f0b\AGENTS.md`
  Confirmed the workstream rules: verify before claiming done, keep a staged summary, and stop at clean checkpoints if a phase is unstable.

## Phase 1 Progress

- 2026-04-08T15:45:27.7461633-04:00 `src/claude/claude-adapter.ts`
  Added the Claude CLI adapter with headless `stream-json` parsing, per-turn system prompt files, extra read directories, and lifecycle handling.
- 2026-04-08T15:45:27.7461633-04:00 `src/claude/brief-collector.ts`
  Added structured brief collection for git state, workstreams, approvals, notes, reminders, and calendar items.
- 2026-04-08T15:45:27.7461633-04:00 `src/orchestrator/orchestrator.ts`
  Wired manual and scheduled brief generation into the orchestrator with saved Markdown output and a Discord event.
- 2026-04-08T15:45:27.7461633-04:00 `src/discord/bot.ts`
  Added `/maverick brief` and brief posting support.
- 2026-04-08T15:45:27.7461633-04:00 `src/config/schema.ts`, `config/control-plane.json`, `.env.example`, `docs/claude-integration.md`
  Updated config schema, local config defaults, operator docs, and environment docs for Phase 1.
- 2026-04-08T15:45:27.7461633-04:00 `test/claude/claude-adapter.test.ts`, `test/claude/schedule.test.ts`, `test/claude/brief-collector.test.ts`
  Added targeted tests for Claude stream parsing, brief scheduling, and collected brief context.

## Next

- Run typecheck, tests, and build for the Phase 1 surface.
- Fix any stability issues before moving to Phase 2.

## Phase 1 Checkpoint

- 2026-04-08T15:46:57.3031887-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` completed without errors.
- 2026-04-08T15:46:57.3031887-04:00 `npm run build`
  Passed. Production TypeScript build completed without errors.
- 2026-04-08T15:46:57.3031887-04:00 `npm test`
  Passed after rerunning outside the sandbox because Vitest could not spawn `esbuild` under sandbox restrictions (`spawn EPERM`). All 5 test files and 18 tests passed.

### Phase 1 Status

- Implemented: Claude CLI backend support, brief collector/renderer/scheduler, manual `/maverick brief`, config/docs updates, and Phase 1 tests.
- Passed: `npm run lint`, `npm run build`, `npm test`.
- Remains: Phase 2 Claude post-turn review and Phase 3 Claude planning.
- Risks and follow-up: Claude CLI behavior still depends on the locally installed `claude` binary and its `stream-json` output shape; Phase 2 will harden this further by exercising the adapter in review flows.

## Phase 2 Progress

- 2026-04-08T15:53:38.8503740-04:00 `src/config/schema.ts`, `config/control-plane.json`
  Added per-project `claudeReview` config and updated the local control-plane config with disabled defaults.
- 2026-04-08T15:53:38.8503740-04:00 `src/claude/context-builder.ts`, `src/claude/claude-adapter.ts`
  Added grounded Claude review prompts and structured review result parsing.
- 2026-04-08T15:53:38.8503740-04:00 `src/orchestrator/orchestrator.ts`, `src/orchestrator/event-bus.ts`
  Added manual Claude review, auto-review after completed Codex turns, and Discord review events.
- 2026-04-08T15:53:38.8503740-04:00 `src/discord/bot.ts`
  Added `/workstream review --claude` and Discord review posting.
- 2026-04-08T15:53:38.8503740-04:00 `test/claude/review.test.ts`, `docs/claude-integration.md`
  Added Phase 2 tests and operator docs for Claude review.

## Phase 2 Checkpoint

- 2026-04-08T15:54:37.0314766-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` completed without errors after the review integration changes.
- 2026-04-08T15:54:37.0314766-04:00 `npm run build`
  Passed. Production TypeScript build completed without errors after the review integration changes.
- 2026-04-08T15:54:37.0314766-04:00 `npm test`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted process spawning for `esbuild`. All 6 test files and 22 tests passed.

### Phase 2 Status

- Implemented: per-project Claude review config, grounded review prompt construction, structured review parsing, optional auto-review after completed Codex turns, manual `/workstream review --claude`, and Discord review notifications.
- Passed: `npm run lint`, `npm run build`, `npm test`.
- Remains: Phase 3 Claude planning, workstream plan storage, dispatch plan injection, and optional planning-state automation.
- Risks and follow-up: Claude review currently uses the latest recorded turn output from the event log or summary fallback because Maverick does not yet persist full turn outputs as first-class artifacts.

## Phase 3 Progress

- 2026-04-08T15:59:55.0673942-04:00 `src/state/schema.sql`, `src/state/database.ts`, `src/state/repositories.ts`
  Added persistent workstream plan storage and an idempotent database column backfill for existing databases.
- 2026-04-08T15:59:55.0673942-04:00 `src/claude/context-builder.ts`, `src/claude/types.ts`
  Added the planning prompt builder and planning context payload types.
- 2026-04-08T15:59:55.0673942-04:00 `src/orchestrator/orchestrator.ts`
  Added Claude plan generation, plan-aware dispatch injection, and optional auto-plan on entry to the planning state.
- 2026-04-08T15:59:55.0673942-04:00 `src/discord/bot.ts`, `config/control-plane.json`, `docs/claude-integration.md`
  Added `/workstream plan`, exposed disabled planning config defaults, and documented the planning workflow.
- 2026-04-08T15:59:55.0673942-04:00 `test/claude/planning.test.ts`
  Added Phase 3 tests for planning prompt construction and stored workstream plans.

## Phase 3 Checkpoint

- 2026-04-08T16:01:18.6506854-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` completed without errors after the planning and schema changes.
- 2026-04-08T16:01:18.6506854-04:00 `npm run build`
  Passed. Production TypeScript build completed without errors after the planning and schema changes.
- 2026-04-08T16:01:18.6506854-04:00 `npm test`
  Passed after rerunning outside the sandbox because Vitest still requires unrestricted process spawning for `esbuild`. All 7 test files and 24 tests passed.

### Phase 3 Status

- Implemented: Claude planning config, stored workstream plans, `/workstream plan`, plan-aware dispatch injection, optional auto-plan on planning-state entry, and supporting docs/tests.
- Passed: `npm run lint`, `npm run build`, `npm test`.
- Remains: no further implementation phases from the Claude integration plan.
- Risks and follow-up: plan injection currently applies when the dispatch instruction exactly matches the stored workstream goal, which keeps behavior explicit but means operators need to regenerate the plan if the instruction changes materially.
