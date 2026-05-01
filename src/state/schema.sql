-- Codex Orchestrator runtime state schema
-- All timestamps are ISO 8601 UTC strings

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Projects registered in the orchestrator
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  repo_path       TEXT NOT NULL,
  config_json     TEXT NOT NULL,  -- serialized ProjectConfig
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Workstreams: the central unit of work
CREATE TABLE IF NOT EXISTS workstreams (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  epic_id             TEXT,
  name                TEXT NOT NULL,
  description         TEXT,
  state               TEXT NOT NULL DEFAULT 'intake',
  current_goal        TEXT,
  cwd                 TEXT,            -- working directory (may be a worktree)
  branch              TEXT,            -- git branch associated with this workstream
  base_branch         TEXT,            -- durable branch or ref the worktree was based on

  -- Codex binding
  codex_thread_id     TEXT,
  execution_backend   TEXT NOT NULL DEFAULT 'codex-app-server',

  -- Discord binding
  discord_channel_id  TEXT,
  discord_thread_id   TEXT,
  discord_parent_channel_id TEXT,

  -- Workspace identity
  workspace_mode      TEXT NOT NULL DEFAULT 'legacy-root',

  -- Status flags
  waiting_on_approval INTEGER NOT NULL DEFAULT 0,
  pending_decision    TEXT,            -- JSON description of what decision is needed
  summary             TEXT,            -- latest summary of progress
  plan                TEXT,            -- latest stored Claude implementation plan
  planning_context_json TEXT,          -- durable structured planning state
  verification_context_json TEXT,      -- latest structured verification state
  budget_limit_usd   REAL NOT NULL DEFAULT 5.0,
  budget_spent_usd   REAL NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_workstreams_project ON workstreams(project_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_state ON workstreams(state);
CREATE INDEX IF NOT EXISTS idx_workstreams_discord_channel ON workstreams(discord_channel_id);
CREATE INDEX IF NOT EXISTS idx_workstreams_discord_thread ON workstreams(discord_thread_id);

-- Per-host runtime bindings for workstreams. The durable workstream row is shared,
-- while cwd/Codex thread identity can differ between Windows and Linux.
CREATE TABLE IF NOT EXISTS workstream_runtime_bindings (
  workstream_id    TEXT NOT NULL REFERENCES workstreams(id),
  instance_id      TEXT NOT NULL,
  cwd              TEXT,
  codex_thread_id  TEXT,
  runtime_status   TEXT NOT NULL DEFAULT 'idle',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workstream_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_workstream_runtime_instance ON workstream_runtime_bindings(instance_id);

-- Cross-host operation guard. This preserves existing Discord routing while
-- preventing two bot instances from mutating the same workstream at once.
CREATE TABLE IF NOT EXISTS active_workstream_operations (
  workstream_id       TEXT PRIMARY KEY REFERENCES workstreams(id),
  operation_kind      TEXT NOT NULL,
  owner_instance_id   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',
  started_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_active_workstream_operations_owner ON active_workstream_operations(owner_instance_id);

-- Turns: individual units of execution within a workstream
CREATE TABLE IF NOT EXISTS turns (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id),
  codex_turn_id   TEXT,
  instruction     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
  result_summary  TEXT,
  started_at      TEXT,
  last_progress_at TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_workstream ON turns(workstream_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_running_per_workstream
  ON turns(workstream_id)
  WHERE status = 'running';

-- Approvals: pending and resolved approval requests
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id),
  turn_id         TEXT REFERENCES turns(id),
  type            TEXT NOT NULL,      -- command, file-change, network, connector, user-input
  description     TEXT NOT NULL,
  context_json    TEXT,               -- full context from Codex (command, paths, etc.)
  tier            TEXT NOT NULL,      -- auto, approval-gated, human-decision
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, denied, expired
  decided_by      TEXT,               -- 'auto' or Discord user ID
  decided_at      TEXT,
  discord_message_id TEXT,            -- the Discord message with approval buttons
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approvals_workstream ON approvals(workstream_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Decisions: human decisions logged for audit trail
CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id),
  question        TEXT NOT NULL,
  options_json    TEXT,               -- JSON array of options presented
  chosen_option   TEXT,
  rationale       TEXT,
  decided_by      TEXT NOT NULL,
  discord_message_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_workstream ON decisions(workstream_id);

-- Events: append-only log of everything that happens
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id   TEXT REFERENCES workstreams(id),
  project_id      TEXT REFERENCES projects(id),
  event_type      TEXT NOT NULL,      -- workstream.created, turn.started, approval.requested, state.changed, etc.
  payload_json    TEXT NOT NULL,
  source          TEXT NOT NULL,      -- codex, discord, orchestrator, http
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_workstream ON events(workstream_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

-- Artifacts: files, diffs, and other outputs produced by workstreams
CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  workstream_id   TEXT NOT NULL REFERENCES workstreams(id),
  turn_id         TEXT REFERENCES turns(id),
  type            TEXT NOT NULL,      -- diff, file, log, summary, review
  name            TEXT NOT NULL,
  content         TEXT,               -- inline content (for small artifacts)
  path            TEXT,               -- filesystem path (for large artifacts)
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_workstream ON artifacts(workstream_id);

-- Assistant inbox: inbound/outbound personal assistant messages
CREATE TABLE IF NOT EXISTS assistant_messages (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,      -- sms, api
  direction       TEXT NOT NULL,      -- inbound, outbound
  contact         TEXT,
  project_id      TEXT REFERENCES projects(id),
  lane_id         TEXT,
  thread_id       TEXT,
  body            TEXT NOT NULL,
  normalized_body TEXT NOT NULL,
  intent          TEXT,
  status          TEXT NOT NULL DEFAULT 'received', -- received, processed, clarification-needed, rejected, sent, failed
  metadata_json   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_contact ON assistant_messages(contact);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_created ON assistant_messages(created_at);

-- Durable Discord thread bindings for project/lane routing and assistant ownership
CREATE TABLE IF NOT EXISTS discord_thread_bindings (
  thread_id          TEXT PRIMARY KEY,
  parent_channel_id  TEXT NOT NULL,
  project_id         TEXT NOT NULL REFERENCES projects(id),
  epic_id            TEXT,
  lane               TEXT,
  base_branch        TEXT,
  assistant_enabled  INTEGER NOT NULL DEFAULT 0,
  owner_instance_id  TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discord_thread_bindings_project ON discord_thread_bindings(project_id);
CREATE INDEX IF NOT EXISTS idx_discord_thread_bindings_parent ON discord_thread_bindings(parent_channel_id);

-- Assistant notes captured from inbound messages
CREATE TABLE IF NOT EXISTS assistant_notes (
  id              TEXT PRIMARY KEY,
  message_id      TEXT REFERENCES assistant_messages(id),
  source_contact  TEXT,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  note_context    TEXT NOT NULL DEFAULT 'general',
  note_kind       TEXT,
  project_name    TEXT,
  smart_goal_ids_json TEXT,
  attachments_json TEXT,
  storage_path    TEXT,
  tags_json       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_notes_message ON assistant_notes(message_id);
CREATE INDEX IF NOT EXISTS idx_assistant_notes_created ON assistant_notes(created_at);

-- Assistant tasks captured from natural chat and linked follow-up artifacts
CREATE TABLE IF NOT EXISTS assistant_tasks (
  id                TEXT PRIMARY KEY,
  message_id        TEXT REFERENCES assistant_messages(id),
  source_contact    TEXT,
  title             TEXT NOT NULL,
  details           TEXT NOT NULL,
  primary_context   TEXT NOT NULL DEFAULT 'personal',
  status            TEXT NOT NULL DEFAULT 'inbox', -- inbox, open, scheduled, done, archived
  due_at            TEXT,
  scheduled_for     TEXT,
  note_id           TEXT REFERENCES assistant_notes(id),
  reminder_id       TEXT REFERENCES assistant_reminders(id),
  calendar_event_id TEXT REFERENCES assistant_calendar_events(id),
  completed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_status ON assistant_tasks(status);
CREATE INDEX IF NOT EXISTS idx_assistant_tasks_due ON assistant_tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_assistant_tasks_scheduled ON assistant_tasks(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_assistant_tasks_message ON assistant_tasks(message_id);

-- Calendar intents recorded by the assistant and optionally synced to a provider
CREATE TABLE IF NOT EXISTS assistant_calendar_events (
  id                TEXT PRIMARY KEY,
  message_id        TEXT REFERENCES assistant_messages(id),
  source_contact    TEXT,
  title             TEXT NOT NULL,
  details           TEXT,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT,
  recurrence_rule   TEXT,
  timezone          TEXT NOT NULL,
  location          TEXT,
  provider          TEXT NOT NULL DEFAULT 'memory',
  provider_event_id TEXT,
  sync_status       TEXT NOT NULL DEFAULT 'pending', -- pending, synced, pending-config, failed
  sync_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_calendar_message ON assistant_calendar_events(message_id);
CREATE INDEX IF NOT EXISTS idx_assistant_calendar_starts_at ON assistant_calendar_events(starts_at);

-- Reminder intents captured by the assistant and dispatched through SMS
CREATE TABLE IF NOT EXISTS assistant_reminders (
  id                  TEXT PRIMARY KEY,
  message_id          TEXT REFERENCES assistant_messages(id),
  source_contact      TEXT,
  body                TEXT NOT NULL,
  remind_at           TEXT NOT NULL,
  channel             TEXT NOT NULL DEFAULT 'sms',
  destination         TEXT,
  provider            TEXT NOT NULL DEFAULT 'disabled',
  status              TEXT NOT NULL DEFAULT 'scheduled', -- scheduled, sent, failed, cancelled
  sent_at             TEXT,
  provider_message_id TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_reminders_due ON assistant_reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_assistant_reminders_message ON assistant_reminders(message_id);

-- Assistant settings and model overrides
CREATE TABLE IF NOT EXISTS assistant_settings (
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL, -- global, discord-channel
  scope_id        TEXT NOT NULL,
  feature         TEXT NOT NULL,
  profile         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_settings_scope_feature
  ON assistant_settings(scope_type, scope_id, feature);
