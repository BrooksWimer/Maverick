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

## Agent Migration Phase 1

- 2026-04-14T21:31:39.0138389-04:00 `src/agents/*`, `src/agents/planning-support.ts`
  Imported the existing `src/agents` baseline into this worktree, fixed the copied `incident-triage-agent.ts` syntax breakage, extended the planning contract for decision-gated output, and added helpers for structured planning context persistence, answer merging, and rendered plan summaries.
- 2026-04-14T21:31:39.0138389-04:00 `src/state/schema.sql`, `src/state/database.ts`, `src/state/repositories.ts`
  Added durable `planning_context_json` storage on workstreams so Maverick can persist the full planning conversation state instead of a single plan blob.
- 2026-04-14T21:31:39.0138389-04:00 `src/orchestrator/orchestrator.ts`, `src/orchestrator/event-bus.ts`
  Routed live planning through `runAgent("planning")`, persisted structured planning state, emitted planning-ready and decision-needed events, added `provideDecisionAnswers()`, and made dispatch prefer the stored final execution prompt when it matches the planned instruction.
- 2026-04-14T21:31:39.0138389-04:00 `src/discord/bot.ts`
  Added decision-gated planning UX with `/workstream answer-plan`, parsing for structured operator answers, auto-plan notifications, and richer workstream status reporting for pending planning questions versus ready prompts.
- 2026-04-14T21:31:39.0138389-04:00 `test/agents/planning-support.test.ts`, `test/orchestrator/planning-agent.test.ts`, `test/discord/bot.test.ts`, `test/claude/planning.test.ts`
  Added and updated tests covering planning-result normalization, planning-context persistence, the end-to-end plan -> answer -> final prompt loop, dispatch prompt reuse, and Discord answer parsing.

### Agent Migration Phase 1 Checkpoint

- 2026-04-14T21:31:39.0138389-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` succeeded after importing the agent layer and wiring the planning migration.
- 2026-04-14T21:31:39.0138389-04:00 `npm run build`
  Passed. Production TypeScript build succeeded with the new planning persistence and Discord answer flow.
- 2026-04-14T21:31:39.0138389-04:00 `npx vitest run test/agents/planning-support.test.ts test/orchestrator/planning-agent.test.ts test/claude/planning.test.ts test/discord/bot.test.ts`
  Passed after rerunning outside the sandbox because Vitest hit `spawn EPERM` from `esbuild` in the sandbox. All 4 targeted files and 12 tests passed.

### Agent Migration Phase 1 Status

- Implemented: agent-driven planning, durable decision-gated planning context, operator answer capture and resume, stored final execution prompt synthesis, and dispatch reuse of the finalized prompt.
- Passed: `npm run lint`, `npm run build`, targeted Vitest coverage for the planning migration surface.
- Remains: route live review and brief generation through the same agent layer, then add the smallest broader orchestration extension on top of that foundation.

## Agent Migration Phase 2

- 2026-04-14T21:36:13.1871864-04:00 `src/orchestrator/orchestrator.ts`
  Routed the live Claude review path through `runAgent("review")` and the live brief path through `runAgent("brief")`, while keeping `src/claude` as the transport/runtime layer underneath the agent runner.
- 2026-04-14T21:36:13.1871864-04:00 `src/agents/review-support.ts`, `src/agents/brief-support.ts`
  Added coercion and rendering helpers so agent-structured review and brief outputs map back onto Maverick's current review result surface and stored brief markdown flow.
- 2026-04-14T21:36:13.1871864-04:00 `test/agents/review-support.test.ts`, `test/agents/brief-support.test.ts`, `test/orchestrator/review-brief-agent.test.ts`
  Added support and integration coverage proving that review and brief generation now use the agent runner instead of the legacy direct prompt path.

### Agent Migration Phase 2 Checkpoint

- 2026-04-14T21:36:13.1871864-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` stayed clean after swapping review and brief over to the agent layer.
- 2026-04-14T21:36:13.1871864-04:00 `npm run build`
  Passed. Production TypeScript build succeeded after the review/brief agent routing changes.
- 2026-04-14T21:36:13.1871864-04:00 `npx vitest run test/agents/planning-support.test.ts test/agents/review-support.test.ts test/agents/brief-support.test.ts test/orchestrator/planning-agent.test.ts test/orchestrator/review-brief-agent.test.ts test/claude/planning.test.ts test/claude/review.test.ts test/discord/bot.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 8 targeted files and 19 tests passed.

### Agent Migration Phase 2 Status

- Implemented: live review routing through `src/agents`, live brief routing through `src/agents`, and compatibility formatting so downstream Discord and artifact behavior remain stable.
- Passed: `npm run lint`, `npm run build`, the combined planning/review/brief targeted Vitest suite.
- Remains: add the smallest stable broader orchestration extension on top of the now-live agent layer.

## Agent Migration Phase 3

- 2026-04-14T21:39:59.6546000-04:00 `src/orchestrator/orchestrator.ts`, `src/agents/epic-context-support.ts`
  Added a narrow but real broader-orchestration extension: epic-bound workstreams now run the existing `epic-context` agent so planning and Claude review inherit dynamic sibling workstream state, recent epic events, and next-workstream context in addition to the static epic charter.
- 2026-04-14T21:39:59.6546000-04:00 `test/orchestrator/epic-context-agent.test.ts`
  Added integration coverage proving that the planning path requests epic-context analysis first and injects the generated summary into the subsequent planning agent context.
- 2026-04-14T21:39:59.6546000-04:00 `docs/claude-integration.md`
  Updated operator-facing docs to describe the live agent-layer routing, `/workstream answer-plan`, stored final execution prompts, and dynamic epic-context enrichment.

### Agent Migration Phase 3 Checkpoint

- 2026-04-14T21:39:59.6546000-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` remained clean after the epic-context agent integration.
- 2026-04-14T21:39:59.6546000-04:00 `npm run build`
  Passed. Production TypeScript build succeeded after the Phase 3 orchestration extension.
- 2026-04-14T21:39:59.6546000-04:00 `npx vitest run test/agents/planning-support.test.ts test/agents/review-support.test.ts test/agents/brief-support.test.ts test/orchestrator/planning-agent.test.ts test/orchestrator/review-brief-agent.test.ts test/orchestrator/epic-context-agent.test.ts test/claude/planning.test.ts test/claude/review.test.ts test/discord/bot.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 9 targeted files and 20 tests passed.

### Agent Migration Phase 3 Status

- Implemented: dynamic epic-context propagation through the agent layer for planning and Claude review, giving workstreams broader state-aware context without introducing a full autonomous decision loop.
- Passed: `npm run lint`, `npm run build`, the full migrated planning/review/brief/epic-context targeted Vitest suite.
- Remains: future work can expand intake, verification, incident triage, and post-turn autonomous decision loops onto the same agent foundation.

## Agent Migration Blocker Hardening

- 2026-04-14T23:20:33.6352652-04:00 `src/orchestrator/orchestrator.ts`, `src/agents/planning-support.ts`, `src/agents/planning-agent.ts`
  Hardened the planning lifecycle so dispatch is blocked while planning questions remain unresolved, a stored planning flow is only treated as dispatch-ready when the agent returns a real `finalExecutionPrompt`, and fresh planning runs no longer silently resume prior planning threads.
- 2026-04-14T23:20:33.6352652-04:00 `src/discord/bot.ts`
  Added explicit `/workstream plan` resume semantics with a boolean resume flag and updated user-facing plan status text so Discord only claims the final prompt is ready when a real final execution prompt exists.
- 2026-04-14T23:20:33.6352652-04:00 `test/agents/planning-support.test.ts`, `test/orchestrator/planning-agent.test.ts`
  Added regression coverage for `needs-final-prompt` status, blocked dispatch while planning questions are pending, and the fresh-vs-explicit-resume thread behavior.

### Agent Migration Blocker Hardening Checkpoint

- 2026-04-14T23:20:33.6352652-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` succeeded after the planning lifecycle hardening changes.
- 2026-04-14T23:20:33.6352652-04:00 `npx vitest run test/agents/planning-support.test.ts test/orchestrator/planning-agent.test.ts test/claude/planning.test.ts test/discord/bot.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 4 targeted files and 14 tests passed.

### Agent Migration Blocker Hardening Status

- Implemented: dispatch guard for unresolved planning, explicit fresh-versus-resume planning behavior, and real final-prompt readiness semantics.
- Passed: `npm run lint` and the focused planning blocker regression suite.
- Remains: extend the live planning flow with intake/goal-framing and the broader decision-maker agent layers.

## Decision-Maker Phase 2

- 2026-04-14T23:32:10.6265569-04:00 `src/orchestrator/orchestrator.ts`, `src/agents/goal-framing-support.ts`, `src/agents/planning-support.ts`
  Added real pre-planning layers to the live planning path: fresh planning now runs the existing `intake` and `goal-framing` agents before the planning agent, persists both results on `planning_context_json`, and injects the scoped intake plus goal frame back into planning and resume runs.
- 2026-04-14T23:32:10.6265569-04:00 `src/agents/goal-framing-agent.ts`, `src/agents/planning-agent.ts`
  Updated agent applicability so the live `/workstream plan` path can legally run the intake, goal-framing, and planning sequence from workstreams that are still in the `intake` state.
- 2026-04-14T23:32:10.6265569-04:00 `test/agents/goal-framing-support.test.ts`, `test/agents/planning-support.test.ts`, `test/orchestrator/planning-agent.test.ts`, `docs/claude-integration.md`
  Added support and integration coverage for intake/goal-frame parsing, planning-context persistence, fresh-plan sequencing, resume reuse of stored intake/goal framing, and updated operator docs to describe the new planning pipeline.

### Decision-Maker Phase 2 Checkpoint

- 2026-04-14T23:32:10.6265569-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` remained clean after wiring intake and goal framing into the live planning flow.
- 2026-04-14T23:32:10.6265569-04:00 `npx vitest run test/agents/goal-framing-support.test.ts test/agents/planning-support.test.ts test/orchestrator/planning-agent.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 3 targeted files and 9 tests passed.

### Decision-Maker Phase 2 Status

- Implemented: state-intake and goal-framing layers as real inputs to structured planning, persisted on the workstream and reused on resume.
- Passed: `npm run lint` and the focused intake/goal-framing/planning suite.
- Remains: add the operator-feedback, Discord-formatting, modeling, and test-design layers on top of this planning foundation.

## Decision-Maker Phase 3

- 2026-04-14T23:41:42.3317106-04:00 `src/agents/operator-feedback-agent.ts`, `src/agents/operator-feedback-support.ts`, `src/agents/response-formatting-agent.ts`, `src/agents/response-formatting-support.ts`, `src/agents/types.ts`, `src/agents/agent-runner.ts`
  Added two new live planning-adjacent agents on top of the existing `src/agents` layer: `operator-feedback` to turn pending planning decisions into a cleaner questionnaire and `response-formatting` to generate Discord-friendly Markdown explanations from structured planning state.
- 2026-04-14T23:41:42.3317106-04:00 `src/orchestrator/orchestrator.ts`, `src/orchestrator/event-bus.ts`, `src/discord/bot.ts`
  Wired those agents into the planning lifecycle so stored planning context now persists a feedback request and a formatted explanation, emits formatted planning events, and uses the explanation Markdown for Discord previews while still attaching the full rendered planning context.
- 2026-04-14T23:41:42.3317106-04:00 `test/agents/operator-feedback-support.test.ts`, `test/agents/response-formatting-support.test.ts`, `test/agents/planning-support.test.ts`, `test/orchestrator/planning-agent.test.ts`, `docs/claude-integration.md`
  Added support and integration coverage proving that the questionnaire and explanation layers are real, persisted, and threaded through the live planning path and operator-facing docs.

### Decision-Maker Phase 3 Checkpoint

- 2026-04-14T23:41:42.3317106-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` stayed clean after adding the feedback and response-formatting agents plus the new planning-context fields.
- 2026-04-14T23:41:42.3317106-04:00 `npx vitest run test/agents/operator-feedback-support.test.ts test/agents/response-formatting-support.test.ts test/agents/planning-support.test.ts test/orchestrator/planning-agent.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 4 targeted files and 11 tests passed.

### Decision-Maker Phase 3 Status

- Implemented: decision-gate questionnaire generation, Discord-friendly explanation formatting, persisted communication artifacts on planning context, and bot/event reuse of the formatted explanation.
- Passed: `npm run lint` and the focused planning communication suite.
- Remains: add the modeling and test-design layers, then finish docs and final verification.

## Decision-Maker Phase 4

- 2026-04-14T23:50:01.6531063-04:00 `src/agents/modeling-agent.ts`, `src/agents/modeling-support.ts`, `src/agents/test-design-agent.ts`, `src/agents/test-design-support.ts`, `src/agents/types.ts`, `src/agents/agent-runner.ts`
  Added two more live planning-support agents on the existing `src/agents` foundation: `modeling` to create a durable system model and Mermaid diagram for the active workstream, and `test-design` to create explicit test-first execution prep with concrete cases, checklist items, and suggested commands.
- 2026-04-14T23:50:01.6531063-04:00 `src/orchestrator/orchestrator.ts`, `src/agents/planning-support.ts`
  Wired those layers into the live planning lifecycle so fresh planning now runs `intake -> goal-framing -> modeling -> test-design -> planning`, persists the model and test design on the workstream, reuses them on resume, and injects both into the planning agent context.
- 2026-04-14T23:50:01.6531063-04:00 `src/orchestrator/orchestrator.ts`, `test/orchestrator/review-brief-agent.test.ts`, `docs/claude-integration.md`
  Extended the live Claude review path so stored planning models and test-design artifacts flow into the review agent context, then updated docs and integration coverage to prove that downstream quality paths can see those artifacts.

### Decision-Maker Phase 4 Checkpoint

- 2026-04-14T23:50:01.6531063-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` stayed clean after adding the modeling and test-design layers and the new planning-context fields.
- 2026-04-14T23:50:01.6531063-04:00 `npx vitest run test/agents/modeling-support.test.ts test/agents/test-design-support.test.ts test/agents/planning-support.test.ts test/orchestrator/planning-agent.test.ts test/orchestrator/review-brief-agent.test.ts`
  Passed after rerunning outside the sandbox because Vitest still needs unrestricted `esbuild` process spawning. All 5 targeted files and 10 tests passed.

### Decision-Maker Phase 4 Status

- Implemented: modeling and test-first execution-prep layers as real planning inputs, persisted workstream artifacts, and downstream review-context reuse.
- Passed: `npm run lint` and the focused modeling/test-design/planning/review suite.
- Remains: final docs alignment and broader whole-surface verification.

## Decision-Maker Final Verification

- 2026-04-14T23:53:16.2483216-04:00 `test/orchestrator/review-brief-agent.test.ts`, `test/orchestrator/planning-agent.test.ts`, `test/orchestrator/epic-context-agent.test.ts`, `test/orchestrator/epic-context.test.ts`, `test/claude/brief-collector.test.ts`, `test/claude/planning.test.ts`, `test/daily-brief/service.test.ts`
  Hardened Windows temp-directory cleanup in the temp-repo tests with retryable `rmSync` settings so the expanded full-suite run stays stable under real parallel timing instead of only in narrow targeted runs.
- 2026-04-14T23:53:16.2483216-04:00 `npm run build`
  Passed. Production TypeScript build succeeded after the full decision-maker expansion.
- 2026-04-14T23:53:16.2483216-04:00 `npm test`
  Passed outside the sandbox after rerunning with unrestricted process spawning for Vitest/esbuild. All 24 test files and 61 tests passed.
- 2026-04-14T23:54:47.8585437-04:00 `src/agents/review-agent.ts`, `npm run lint`, `npx vitest run test/orchestrator/review-brief-agent.test.ts test/claude/review.test.ts`, `npm test`
  Aligned the review agent's applicable states with the real manual-review workflow, then re-ran the focused review checks and the full test suite. Final result stayed green: 24 test files and 61 tests passed.

### Decision-Maker Final Status

- Implemented: blocker hardening, intake, goal framing, structured planning, operator questionnaire generation, Discord explanation formatting, system modeling, test-first execution prep, resume reuse, and downstream review-context reuse of stored planning artifacts.
- Passed: `npm run lint`, `npm run build`, and `npm test`.
- Remains: future work can build a true autonomous post-turn continuation loop, live verification-agent routing, native poll UX, explicit awaiting-decisions workflow state, and broader incident/continuation orchestration on the same agent foundation.

## Remaining Architecture Phase 1

- 2026-04-15T00:20:05.0880225-04:00 `src/config/schema.ts`, `src/orchestrator/orchestrator.ts`, `src/agents/planning-agent.ts`
  Added the explicit `awaiting-decisions` workflow state, synchronized planning question gates onto real workflow transitions, let resumed planning run cleanly from that state, and advanced ready planned workstreams into `implementation` when dispatch starts.
- 2026-04-15T00:20:05.0880225-04:00 `test/orchestrator/planning-agent.test.ts`
  Extended planning integration coverage to prove the state path is now real: `intake -> planning -> awaiting-decisions -> planning -> implementation`.

### Remaining Architecture Phase 1 Checkpoint

- 2026-04-15T00:20:05.0880225-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` stayed clean after introducing the explicit decision-waiting state and dispatch state advance.
- 2026-04-15T00:20:05.0880225-04:00 `npm test -- --run test/orchestrator/planning-agent.test.ts`
  Passed outside the sandbox after rerunning with unrestricted `esbuild` spawning. The focused planning state suite passed with 2 tests.

### Remaining Architecture Phase 1 Status

- Implemented: explicit `awaiting-decisions` workflow state, planning-state synchronization, resumed planning applicability, and dispatch advancement into `implementation`.
- Passed: `npm run lint` and the focused planning state regression test.
- Remains: live verification-agent routing and failure continuation.

## Remaining Architecture Phase 2

- 2026-04-15T00:20:05.0880225-04:00 `src/agents/verification-support.ts`, `src/agents/types.ts`, `src/state/schema.sql`, `src/state/database.ts`, `src/state/repositories.ts`
  Added a durable structured verification record on workstreams with parsing/rendering helpers and a database-backed `verification_context_json` field.
- 2026-04-15T00:20:05.0880225-04:00 `src/config/schema.ts`, `src/orchestrator/orchestrator.ts`, `src/orchestrator/event-bus.ts`, `src/http/server.ts`, `src/discord/bot.ts`
  Added `claudeVerification` project config, live `verify()` orchestration through `runAgent("verification")`, `/workstream verify`, verification events/notifications, and automatic `implementation -> verification -> review|implementation` flow after completed Codex turns.
- 2026-04-15T00:20:05.0880225-04:00 `test/agents/verification-support.test.ts`, `test/orchestrator/verification-agent.test.ts`
  Added support and integration coverage proving verification context persistence, state transitions, auto-verification after completed turns, and downstream review reuse of stored verification results.

### Remaining Architecture Phase 2 Checkpoint

- 2026-04-15T00:20:05.0880225-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` stayed clean after wiring verification into the live agent orchestration loop.
- 2026-04-15T00:20:05.0880225-04:00 `npm run build`
  Passed. Production TypeScript build succeeded after the verification-context and Discord/API surface changes.
- 2026-04-15T00:20:05.0880225-04:00 `npm test -- --run test/agents/verification-support.test.ts test/orchestrator/verification-agent.test.ts test/orchestrator/review-brief-agent.test.ts`
  Passed outside the sandbox after rerunning with unrestricted `esbuild` spawning. The focused verification/review suite passed with 7 tests.

### Remaining Architecture Phase 2 Status

- Implemented: durable verification context, live verification-agent routing, manual `/workstream verify`, automatic post-turn verification, and review reuse of structured verification results.
- Passed: `npm run lint`, `npm run build`, and the focused verification/review suite.
- Remains: failure triage and continuation.

## Remaining Architecture Phase 3

- 2026-04-15T00:20:05.0880225-04:00 `src/agents/incident-triage-support.ts`, `src/agents/verification-support.ts`, `src/orchestrator/orchestrator.ts`
  Added failure-continuation support on top of verification: introduced verification failures now run the `incident-triage` agent, persist the triage result on the stored verification record, and seed the next implementation goal from the diagnosed fix when escalation is not required.
- 2026-04-15T00:20:05.0880225-04:00 `test/agents/incident-triage-support.test.ts`, `test/orchestrator/verification-agent.test.ts`
  Added support and integration coverage proving that failed verification produces a persisted triage result and a concrete continuation goal instead of only a failed state.

### Remaining Architecture Phase 3 Checkpoint

- 2026-04-15T00:20:05.0880225-04:00 `npm run lint`
  Passed. TypeScript `--noEmit` remained clean after adding the verification-failure triage path.
- 2026-04-15T00:20:05.0880225-04:00 `npm run build`
  Passed. Production TypeScript build succeeded after the continuation and triage additions.
- 2026-04-15T00:20:05.0880225-04:00 `npm test -- --run test/agents/verification-support.test.ts test/agents/incident-triage-support.test.ts test/orchestrator/verification-agent.test.ts test/orchestrator/review-brief-agent.test.ts`
  Passed outside the sandbox after rerunning with unrestricted `esbuild` spawning. The focused verification/triage/review suite passed with 9 tests.

### Remaining Architecture Phase 3 Status

- Implemented: incident-triage support, verification-failure diagnosis, persisted continuation context, and automatic next-goal synthesis for non-escalated verification failures.
- Passed: `npm run lint`, `npm run build`, and the focused verification/triage/review suite.
- Remains: final docs alignment, full-suite verification, and future native Discord poll UX if the runtime surface is added cleanly.

## Remaining Architecture Final Verification

- 2026-04-15T00:20:05.0880225-04:00 `test/orchestrator/review-brief-agent.test.ts`
  Hardened one remaining Windows temp-directory cleanup race in the review/brief integration test so the expanded suite does not fail on teardown after the new verification and triage paths increase file activity.
- 2026-04-15T00:20:05.0880225-04:00 `npm test`
  Passed outside the sandbox after rerunning with unrestricted `esbuild` spawning. Final full-suite result: 27 test files and 69 tests passed.

### Remaining Architecture Final Status

- Implemented: explicit decision-waiting workflow state, dispatch advancement into implementation, durable verification context, live verification-agent routing, automatic implementation-verification-review looping, incident-triage continuation on failed verification, richer Discord/API verification surfaces, and review reuse of structured verification results.
- Passed: `npm run lint`, `npm run build`, targeted planning and verification suites, and the full `npm test` run.
- Remains: native Discord poll UX still needs a clean runtime/API surface; current operator feedback remains questionnaire-first through the stored agent output and `/workstream answer-plan`.
