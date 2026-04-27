# Maverick Git Workstream Model

This document defines the git and routing model Maverick should enforce across projects.

## Core Terms

- Canonical Repo Root
  - The configured `repoPath` for a project.
  - This is the durable home of the repository.
  - Treat it as reference context, not the default place to make implementation edits.

- Execution Workspace
  - The recorded `workstream.cwd`.
  - For git-backed projects, this is the only normal place a workstream should write.
  - For notes-only projects, this may be the canonical repo root.

- Durable Base Branch
  - The branch Maverick uses as the stable starting point for new workstreams.
  - This comes from `defaultWorktreeBaseBranch`, a lane's `baseBranch`, or an epic branch.

- Disposable Workstream Branch
  - The short-lived branch created for one workstream.
  - Current naming convention: `maverick/<project>/<lane>/<workstream>-<id>`.

- Workspace Mode
  - `worktree`: dedicated git worktree checkout for a git-backed workstream.
  - `legacy-root`: historical root-bound workspace that should be audited and migrated.
  - `notes`: non-code workspace where git worktree rules do not apply.

## Discord Routing Model

- Forum = project
- Thread = epic or default lane
- Ambient assistant = attached to the thread
- Workstream = disposable task branch created inside the thread's lane
- The global Maverick Assistant channel is a plain text channel, not a git-backed forum.
- The Maverick Self-Updates forum is the git-backed Maverick coding project.

Thread bindings persist:

- `thread_id`
- `parent_channel_id`
- `project_id`
- `epic_id` or `lane`
- `base_branch`
- `assistant_enabled`
- `owner_instance_id`
- `source`

## Current Channel Schema

The configured forum parents are:

- Maverick Self-Updates: `1498437201103421582`
- Astra (`netwise`): `1498135799475081307`
- SyncSonic: `1498137470699569262`
- Portfolio & Resume: `1498138271493132369`
- Work: `1498139409680302180`

The global assistant text channel is:

- Maverick Assistant: `1490188914861019197`

The expected lane/thread names are:

- Maverick Self-Updates: `control-plane`, `discord-routing`, `assistant-infrastructure`, `git-hygiene`, `deployment-ops`
- Astra (`netwise`): `laptop-wifi-scanner`, `mobile-wifi-scanner`, `router-admin-ingestion`
- SyncSonic: `pipewire-transport-stability`, `startup-mic-auto-alignment`, `runtime-ultrasonic-auto-alignment`, `wifi-speakers-manual-alignment`
- Portfolio & Resume: `portfolio`, `resume`
- Work: `job-ops`, `business-context-deep-dives`, `engineering-learning`

Ambient assistant ownership is centralized on the Linux bot. Every project forum route and lane should set
`owner_instance_id` / `ownerInstanceId` to `linux`; Windows may still run slash commands and local execution
where appropriate, but it should not answer ordinary assistant chat.

The Work project uses durable lane branches that match the forum thread names:

- `job-ops`
- `business-context-deep-dives`
- `engineering-learning`

New Work workstreams should branch from the matching durable lane branch and then use the normal disposable
workstream branch naming convention.

## Ownership Rules

- Only one bot instance owns ambient thread replies.
- Slash commands may be available from multiple hosts.
- Background reactions and normal assistant replies must only run on the thread owner host.
- Use `MAVERICK_INSTANCE_ID` to make host identity explicit.

## Git-Backed Project Rules

For `workspaceKind = "git"`:

1. A normal implementation workstream must dispatch from `workspace_mode = worktree`.
2. Writes, edits, and commits belong in the execution workspace.
3. The canonical repo root may be read for context, but it is not the normal write target.
4. Planning must render both the canonical repo root and the execution workspace, with the workspace marked as authoritative.
5. New workstreams must resolve a durable base branch explicitly. Do not silently fall back to ambiguous repo `HEAD`.

## Notes Project Rules

For `workspaceKind = "notes"`:

1. Notes may operate directly in the configured workspace.
2. Git worktree isolation is optional.
3. Use notes mode only for intentionally non-code projects.

## Bootstrap Rules

- Project doctrine files should be committed intentionally.
- Normal workstream creation must inspect bootstrap state, not silently create untracked doctrine files.
- Missing doctrine is an audit concern, not a reason to dirty a repo automatically.

## Cleanup Rules

- Preserve first. Do not prune or reset dirty work until it has been triaged.
- Legacy root-bound workstreams should be marked clearly and migrated deliberately.
- Canonical repo roots should be parked on stable branches, not used as disposable execution surfaces.

## Expected End State

- Every git-backed project has a clear base branch policy.
- Every active coding workstream has a dedicated worktree.
- Every Discord thread maps cleanly to a project lane.
- Every ambient assistant thread has one clear bot owner.
- Maverick can audit drift before dispatch instead of discovering it after code lands in the wrong place.
