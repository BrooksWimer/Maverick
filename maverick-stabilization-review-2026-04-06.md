# Maverick Stabilization Review

**Date:** 2026-04-06
**Scope:** Pre-feature-work audit of orchestrator, codex adapter, HTTP server, Discord bot, assistant layer, config, epics, and database
**Methodology:** Static code review of 10 specified source files plus index.ts entry point

---

## 1. Highest-Priority Issues (Fix Before New Features)

### 1A. HTTP Server Has No Port-Conflict Handling (Confirmed)

You reported that startup fails when the local HTTP port is already in use. The code confirms there is zero handling for this: `index.ts:43` calls `createHttpServer`, which calls `app.listen()` with no try/catch. A Fastify listen failure throws, and `main().catch()` calls `process.exit(1)`, which kills the orchestrator, Discord bot, and assistant too.

**Confirmed bug.** This is the single most operationally impactful issue. A stale Maverick process or any other service on port 3847 takes out the entire system.

**Smallest fix:** Wrap the `createHttpServer` call in index.ts in a try/catch. On `EADDRINUSE`, log a clear warning and continue without HTTP. Optionally retry on port+1. The orchestrator and Discord bot do not depend on the HTTP server.

### 1B. Codex App-Server Process Crash Has No Auto-Recovery (Confirmed Risk)

In `app-server-adapter.ts`, `handleTransportFailure()` sets `this.initialized = false` and rejects all pending requests, but does not attempt to restart the child process. The `ensureProcessRunning()` method (line 988) only checks `!this.process || this.process.killed` and calls `startProcess()`, but does NOT re-run the `initialize()` handshake (the JSON-RPC `initialize` + `initialized` + `thread/list` sequence). So after a crash, the next call to `ensureInitialized()` would call `initialize()` and re-handshake, which is correct -- but any call that goes through `ensureProcessRunning()` directly (like `sendRequest`) could start a process without initializing the protocol.

**Confirmed design gap:** `ensureProcessRunning()` does not set `this.initialized = false` before restarting, and it does not await initialization. If `sendRequest` is called after a crash, it calls `ensureProcessRunning()` which spawns a raw process, then writes a JSON-RPC message to a process that hasn't been initialized yet.

**Smallest fix:** Make `ensureProcessRunning()` call `this.initialized = false` and redirect through `initialize()` instead of just `startProcess()`.

### 1C. The `.codex/state_5.sqlite` Migration Mismatch Warning (Hypothesis)

You mentioned seeing Codex app-server warnings about a state_5.sqlite migration mismatch. This is **not caused by Maverick's own database code** -- Maverick uses `better-sqlite3` with its own `orchestrator.db` and a hand-rolled migration scheme (`ensureColumn`/`ensureIndex`). The state_5.sqlite is internal to the Codex app-server child process.

**Hypothesis:** This happens when the Codex CLI is upgraded (changing its expected schema version) but existing thread state files on disk still have the old schema. Maverick can't fix this directly; it's a Codex-side concern. However, Maverick could:

1. Log the specific stderr lines from the Codex process more prominently (currently they go to `log.warn` under "codex app-server stderr" which is easy to miss).
2. Detect the migration-mismatch pattern in stderr and surface it as a structured event.

**Smallest fix:** Add a regex filter in the `stderrLines` handler to escalate known Codex migration warnings to `log.error` with an actionable message.

### 1D. Shutdown Order Could Strand Codex Process (Confirmed Risk)

In `index.ts`, the shutdown sequence is: Discord stop, assistant shutdown, orchestrator shutdown, HTTP close, DB close. The orchestrator shutdown sends `SIGTERM` to the Codex app-server process. However, if `orchestrator.shutdown()` throws (e.g., the Codex process is already dead), `httpServer.close()` and `closeDatabase()` never run because the shutdown function doesn't have individual try/catch blocks.

**Confirmed:** An unhandled error in any shutdown step skips the remaining steps.

**Smallest fix:** Wrap each shutdown step in its own try/catch in the `shutdown` function.

---

## 2. What Is Already Solid

### Config Validation (schema.ts + loader.ts)
This is the strongest part of the codebase. Zod schema validation catches malformed configs at startup. The loader validates cross-references (routes referencing valid projects, epics existing, doc paths within repo bounds, duplicate channel bindings). The epic charter doc path-traversal check (`isEpicDocPathWithinProject`) is correct and prevents `..` escapes.

### Orchestrator State Machine + Workstream Lifecycle (orchestrator.ts)
The workstream creation flow is thorough: epic resolution, worktree provisioning, thread binding, state tracking, event emission. The `reconcileRecoveredWorkstream` logic correctly handles the restart case where local turn records are stale. The `prepareWorkstreamForDispatch` method properly checks for active turns before dispatching.

### Approval Classification (orchestrator.ts)
The escalation tier classification is well-layered: explicit config rules, then hardcoded safety patterns for dangerous commands, then workstream-scoped auto-approval for safe commands. The remote SSH command inspection (`isConfiguredReadOnlyRemoteCommand`) correctly rejects shell metacharacters and unsafe patterns before auto-approving.

### Assistant Service (service.ts)
Clean separation of concerns. The interpreter fallback chain (AI interpreter -> regex parser) is resilient. Contact allow-listing works correctly for both Discord and SMS. The reminder polling loop uses `unref()` so it doesn't prevent process exit.

### Work Notes Persistence (work-notes.ts)
Solid file-system layout with date-partitioned directories, activity indexes, and smart goal cross-linking. The `sanitizeFilename` function handles the right set of dangerous characters. The attachment download uses proper error handling with per-attachment status tracking.

### Discord Bot (bot.ts)
The interaction handling is well-structured with proper deferred replies, error recovery (replying with ephemeral error messages), and the `safeSend` pattern. The event bus subscriptions correctly use `runBackgroundTask` to avoid blocking.

### Database (database.ts)
The `ensureColumn`/`ensureIndex` pattern is a pragmatic approach for additive schema evolution. It's idempotent and won't break on re-runs. The module-level singleton with `getDatabase()`/`initDatabase()` is simple and correct.

---

## 3. Smallest Hardening Pass

These are the changes I'd make in a single focused session, roughly in priority order:

**3a. Port-conflict resilience in index.ts (~10 lines)**
Wrap `createHttpServer` in try/catch. On failure, log the error and set `httpServer = undefined`. Continue startup. The system is fully functional without HTTP.

**3b. Shutdown resilience in index.ts (~15 lines)**
Wrap each shutdown step in its own try/catch so one failure doesn't skip the rest. Log errors but don't rethrow.

**3c. Fix `ensureProcessRunning()` in app-server-adapter.ts (~5 lines)**
Change `ensureProcessRunning()` to call `await this.initialize()` instead of just `this.startProcess()`, so that a crashed Codex process is properly re-handshaked. Add a guard to prevent recursive initialization.

**3d. Surface Codex stderr migration warnings (~10 lines)**
In the `stderrLines` handler, match known patterns like "migration" or "schema version" and log them at error level with a user-facing suggestion.

**3e. Add request timeout to HTTP endpoints (~5 lines)**
The `/api/workstreams/:id/dispatch` endpoint awaits `orchestrator.dispatch()` which can hang indefinitely if the Codex turn never completes. Consider adding a Fastify `connectionTimeout` or per-route timeout so the HTTP connection doesn't hang forever. This is less urgent since Discord is the primary interface, but it prevents curl sessions from hanging.

**Total: ~45 lines of changes across 2-3 files.**

---

## 4. Epic-Context Propagation Design Assessment

The durable epic-context propagation path is:

1. **Config declaration:** `EpicBranchSchema` defines `charter` with `summary`, `bullets`, and `docs` (pointers to repo-owned files). This is validated by Zod with path-traversal protection.

2. **Route binding:** Discord routes can pin an `epicId`, so channels auto-resolve to the right epic lane without per-command selection.

3. **Workstream creation:** `createWorkstream` resolves the epic, validates branch/lane consistency, and stores `epic_id` on the workstream row.

4. **Turn injection:** `prepareTurnInstruction` calls `buildEpicCharterContext`, which assembles the charter summary, bullets, and resolved doc paths into a plaintext preamble prepended to the user instruction.

5. **Graceful degradation:** If the epic is removed from config after a workstream was created, `prepareTurnInstruction` logs a warning and skips injection rather than throwing.

**Assessment: The design is sound.** Specific observations:

- **Correct layering:** Epic context is injected at the turn level, not baked into the thread. This means if you update the charter in config, the next turn picks up the new context. This is the right choice.

- **Doc pointers are paths, not content:** `buildEpicCharterContext` emits the resolved file paths to the Codex agent but does not read or inline the file contents. This is intentional (the agent can read them), and it avoids bloating the instruction with potentially large documents. This is fine as long as the Codex agent has filesystem access to those paths (which it does via the worktree cwd).

- **One gap worth noting:** The charter context is only injected on `dispatch` turns, not on `steer` turns. This is probably fine since steer is a mid-turn correction and the agent already has the charter context from the initial dispatch. But if you ever add a "resume with new context" flow, you'd want to inject charter context there too.

- **The `docs` validation is startup-only:** The loader warns if a doc path doesn't exist yet (`log.warn`), but doesn't fail. This is the right call for a system where docs might be created after config is written.

---

## Summary

| Category | Items |
|----------|-------|
| **Fix now (blocks stability)** | HTTP port-conflict crash, shutdown error cascade |
| **Fix soon (operational risk)** | Codex process recovery race, stderr warning visibility |
| **Already solid** | Config validation, state machine, approval classification, assistant service, work notes, Discord bot structure |
| **Epic propagation** | Sound design; consider charter injection on steer if you add "resume with new context" |

The system is in good shape for adding features. The four hardening items above are all small, isolated changes that don't require any architectural rework.
