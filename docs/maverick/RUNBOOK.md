# Maverick Operator Runbook

This is the short path for running, recovering, and trusting Maverick after the stabilization cut.

## Runtime Roles

- Linux is the primary server. Set `MAVERICK_ROLE=server` and `MAVERICK_INSTANCE_ID=linux`.
- Windows is a client. Set `MAVERICK_ROLE=client`, `MAVERICK_INSTANCE_ID=windows`, `STATE_BACKEND=remote`, and point `MAVERICK_STATE_URL` at the Linux state API tunnel.
- Only the server role starts Discord, assistant reminder workers, and the five-minute worktree reaper.
- To dogfood locally on Windows, temporarily set `MAVERICK_ROLE=server`, stop the Linux service first, then restore Linux as the only Discord-connected server.

## Normal Loop

1. Start work in a routed Discord thread with `/workstream start`.
2. Generate a bounded plan with `/workstream plan`.
3. Answer any planning questions with the buttons or `/workstream answer-plan`.
4. Dispatch the ready slice with the action button or `/workstream dispatch`.
5. Let auto-verification and review run, or use `/workstream verify` and `/workstream review`.
6. Finish verified work into the durable lane with `/workstream finish`.
7. Promote the durable lane explicitly with `/lane promote`.

## Repair Commands

Use `/workstream repair retry` when the latest safe action failed and should be attempted again.

Use `/workstream repair force-unblock` when Maverick has a stale approval, stale running operation, or local running turn that is blocking progress.

Use `/workstream repair reset-to-planning` when the stored plan is bad or stale enough that a fresh planning pass is safer.

Use `/workstream repair rebind-thread` when a workstream is posting to the wrong Discord channel or no longer infers from the current thread.

Discord status and failure notifications include action buttons for status, retry, verify, finish, force-unblock, and reset-to-planning where those actions make sense.

## Project Memory

Each project can keep durable memory at `docs/maverick/PROJECT_MEMORY.md`.

Maverick feeds this file into planning and appends completion notes when workstreams are archived. Operators may edit it directly when a decision, convention, or known trap should survive across future workstreams.

## Worktree Reaper

The server role runs a worktree reaper every five minutes. It only removes disposable `maverick/...` worktrees that are already archived and whose HEAD is contained by the durable lane branch.

If cleanup is unsafe, the reaper records a skipped reason instead of deleting anything.
