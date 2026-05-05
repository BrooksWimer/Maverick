/**
 * Repository pattern for database access.
 * Each entity gets typed CRUD methods that return plain objects.
 */
import { randomUUID } from "node:crypto";
import { getRuntimeInstanceId } from "../runtime/identity.js";
import { getStateBackendMode, invokeRemoteStateOperation } from "./backend.js";
import { getDatabase } from "./database.js";

// --- Types ---

export interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkstreamRow {
  id: string;
  project_id: string;
  epic_id: string | null;
  name: string;
  description: string | null;
  state: string;
  current_goal: string | null;
  cwd: string | null;
  branch: string | null;
  base_branch: string | null;
  codex_thread_id: string | null;
  execution_backend: string;
  discord_channel_id: string | null;
  discord_thread_id: string | null;
  discord_parent_channel_id: string | null;
  workspace_mode: string;
  waiting_on_approval: number;
  pending_decision: string | null;
  summary: string | null;
  plan: string | null;
  planning_context_json: string | null;
  verification_context_json: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  completed_at: string | null;
}

export interface TurnRow {
  id: string;
  workstream_id: string;
  codex_turn_id: string | null;
  instruction: string;
  status: string;
  result_summary: string | null;
  started_at: string | null;
  last_progress_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  workstream_id: string;
  turn_id: string | null;
  type: string;
  name: string;
  content: string | null;
  path: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  workstream_id: string;
  turn_id: string | null;
  type: string;
  description: string;
  context_json: string | null;
  tier: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  discord_message_id: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  workstream_id: string | null;
  project_id: string | null;
  event_type: string;
  payload_json: string;
  source: string;
  created_at: string;
}

export interface AssistantMessageRow {
  id: string;
  source: string;
  direction: string;
  contact: string | null;
  project_id: string | null;
  lane_id: string | null;
  thread_id: string | null;
  body: string;
  normalized_body: string;
  intent: string | null;
  status: string;
  metadata_json: string | null;
  created_at: string;
}

export interface DiscordThreadBindingRow {
  thread_id: string;
  parent_channel_id: string;
  project_id: string;
  epic_id: string | null;
  lane: string | null;
  base_branch: string | null;
  assistant_enabled: number;
  owner_instance_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantNoteRow {
  id: string;
  message_id: string | null;
  source_contact: string | null;
  title: string;
  content: string;
  note_context: string;
  note_kind: string | null;
  project_name: string | null;
  smart_goal_ids_json: string | null;
  attachments_json: string | null;
  storage_path: string | null;
  tags_json: string | null;
  created_at: string;
}

export interface AssistantTaskRow {
  id: string;
  message_id: string | null;
  source_contact: string | null;
  title: string;
  details: string;
  primary_context: string;
  status: string;
  due_at: string | null;
  scheduled_for: string | null;
  note_id: string | null;
  reminder_id: string | null;
  calendar_event_id: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssistantCalendarEventRow {
  id: string;
  message_id: string | null;
  source_contact: string | null;
  title: string;
  details: string | null;
  starts_at: string;
  ends_at: string | null;
  recurrence_rule: string | null;
  timezone: string;
  location: string | null;
  provider: string;
  provider_event_id: string | null;
  sync_status: string;
  sync_error: string | null;
  created_at: string;
}

export interface AssistantReminderRow {
  id: string;
  message_id: string | null;
  source_contact: string | null;
  body: string;
  remind_at: string;
  channel: string;
  destination: string | null;
  provider: string;
  status: string;
  sent_at: string | null;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
}

export interface AssistantSettingRow {
  id: string;
  scope_type: string;
  scope_id: string;
  feature: string;
  profile: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantItemAssignmentRow {
  item_type: string;
  item_id: string;
  project_id: string;
  lane_id: string | null;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface DashboardPlanItemRow {
  id: string;
  date_key: string;
  section: string;
  item_type: string | null;
  item_id: string | null;
  title: string;
  details: string | null;
  project_id: string | null;
  lane_id: string | null;
  position: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WorkstreamRuntimeBindingRow {
  workstream_id: string;
  instance_id: string;
  cwd: string | null;
  codex_thread_id: string | null;
  runtime_status: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface ActiveWorkstreamOperationRow {
  workstream_id: string;
  operation_kind: string;
  owner_instance_id: string;
  status: string;
  started_at: string;
  last_seen_at: string;
  completed_at: string | null;
}

// --- Projects ---

const localProjects = {
  upsert(data: {
    id: string;
    name: string;
    repo_path: string;
    config_json: string;
  }): ProjectRow {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        repo_path = excluded.repo_path,
        config_json = excluded.config_json,
        updated_at = datetime('now')
    `).run(data.id, data.name, data.repo_path, data.config_json);

    return localProjects.getById(data.id)!;
  },

  getById(id: string): ProjectRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  },

  list(): ProjectRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM projects ORDER BY id ASC").all() as ProjectRow[];
  },
};

// --- Workstreams ---

const localWorkstreams = {
  create(data: {
    id?: string;
    project_id: string;
    epic_id?: string;
    name: string;
    description?: string;
    cwd?: string;
    branch?: string;
    base_branch?: string;
    workspace_mode?: string;
    execution_backend?: string;
    discord_channel_id?: string;
    discord_thread_id?: string;
    discord_parent_channel_id?: string;
  }): WorkstreamRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO workstreams (
        id, project_id, epic_id, name, description, cwd, branch, base_branch, workspace_mode, execution_backend, discord_channel_id, discord_thread_id, discord_parent_channel_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.project_id,
      data.epic_id ?? null,
      data.name,
      data.description ?? null,
      data.cwd ?? null,
      data.branch ?? null,
      data.base_branch ?? null,
      data.workspace_mode ?? "legacy-root",
      data.execution_backend ?? "codex-app-server",
      data.discord_channel_id ?? null,
      data.discord_thread_id ?? null,
      data.discord_parent_channel_id ?? null,
    );
    return localWorkstreams.getById(id)!;
  },

  getById(id: string): WorkstreamRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM workstreams WHERE id = ?").get(id) as WorkstreamRow | undefined;
  },

  listByProject(projectId: string): WorkstreamRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM workstreams WHERE project_id = ? ORDER BY last_activity_at DESC")
      .all(projectId) as WorkstreamRow[];
  },

  listActive(): WorkstreamRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM workstreams WHERE state NOT IN ('done') ORDER BY last_activity_at DESC")
      .all() as WorkstreamRow[];
  },

  listByDiscordChannel(channelId: string): WorkstreamRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM workstreams
      WHERE discord_channel_id = ? OR discord_thread_id = ? OR discord_parent_channel_id = ?
      ORDER BY last_activity_at DESC
    `).all(channelId, channelId, channelId) as WorkstreamRow[];
  },

  update(id: string, fields: Partial<Pick<WorkstreamRow,
    "state" | "current_goal" | "cwd" | "branch" | "base_branch" | "codex_thread_id" |
    "discord_channel_id" | "discord_thread_id" | "discord_parent_channel_id" | "workspace_mode" | "waiting_on_approval" |
    "pending_decision" | "summary" | "plan" | "planning_context_json" | "verification_context_json" |
    "completed_at"
  >>): WorkstreamRow | undefined {
    const db = getDatabase();
    const sets: string[] = ["updated_at = datetime('now')", "last_activity_at = datetime('now')"];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    values.push(id);
    db.prepare(`UPDATE workstreams SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localWorkstreams.getById(id);
  },
};

// --- Discord thread bindings ---

const localDiscordThreadBindings = {
  upsert(data: {
    thread_id: string;
    parent_channel_id: string;
    project_id: string;
    epic_id?: string | null;
    lane?: string | null;
    base_branch?: string | null;
    assistant_enabled?: boolean;
    owner_instance_id?: string | null;
    source?: string;
  }): DiscordThreadBindingRow {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO discord_thread_bindings (
        thread_id, parent_channel_id, project_id, epic_id, lane, base_branch, assistant_enabled, owner_instance_id, source
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        parent_channel_id = excluded.parent_channel_id,
        project_id = excluded.project_id,
        epic_id = excluded.epic_id,
        lane = excluded.lane,
        base_branch = excluded.base_branch,
        assistant_enabled = excluded.assistant_enabled,
        owner_instance_id = excluded.owner_instance_id,
        source = excluded.source,
        updated_at = datetime('now')
    `).run(
      data.thread_id,
      data.parent_channel_id,
      data.project_id,
      data.epic_id ?? null,
      data.lane ?? null,
      data.base_branch ?? null,
      data.assistant_enabled ? 1 : 0,
      data.owner_instance_id ?? null,
      data.source ?? "manual",
    );

    return localDiscordThreadBindings.getByThreadId(data.thread_id)!;
  },

  getByThreadId(threadId: string): DiscordThreadBindingRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM discord_thread_bindings WHERE thread_id = ?").get(threadId) as
      | DiscordThreadBindingRow
      | undefined;
  },

  listByProject(projectId: string): DiscordThreadBindingRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM discord_thread_bindings
      WHERE project_id = ?
      ORDER BY updated_at DESC, thread_id ASC
    `).all(projectId) as DiscordThreadBindingRow[];
  },

  listByParentChannel(parentChannelId: string): DiscordThreadBindingRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM discord_thread_bindings
      WHERE parent_channel_id = ?
      ORDER BY updated_at DESC, thread_id ASC
    `).all(parentChannelId) as DiscordThreadBindingRow[];
  },

  list(): DiscordThreadBindingRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM discord_thread_bindings
      ORDER BY updated_at DESC, thread_id ASC
    `).all() as DiscordThreadBindingRow[];
  },

  delete(threadId: string): void {
    const db = getDatabase();
    db.prepare("DELETE FROM discord_thread_bindings WHERE thread_id = ?").run(threadId);
  },
};

// --- Turns ---

const localTurns = {
  create(data: { workstream_id: string; instruction: string }): TurnRow {
    const db = getDatabase();
    const id = randomUUID();
    db.prepare("INSERT INTO turns (id, workstream_id, instruction) VALUES (?, ?, ?)")
      .run(id, data.workstream_id, data.instruction);
    return localTurns.getById(id)!;
  },

  getById(id: string): TurnRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;
  },

  listByWorkstream(workstreamId: string): TurnRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM turns WHERE workstream_id = ? ORDER BY created_at ASC")
      .all(workstreamId) as TurnRow[];
  },

  listRunningByWorkstream(workstreamId: string): TurnRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM turns WHERE workstream_id = ? AND status = 'running' ORDER BY created_at ASC")
      .all(workstreamId) as TurnRow[];
  },

  update(id: string, fields: Partial<Pick<TurnRow,
    "codex_turn_id" | "status" | "result_summary" | "started_at" | "last_progress_at" | "completed_at"
  >>): TurnRow | undefined {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) return localTurns.getById(id);
    values.push(id);
    db.prepare(`UPDATE turns SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localTurns.getById(id);
  },
};

// --- Artifacts ---

const localArtifacts = {
  create(data: {
    id?: string;
    workstream_id: string;
    turn_id?: string | null;
    type: string;
    name: string;
    content?: string | null;
    path?: string | null;
    metadata_json?: string | null;
  }): ArtifactRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO artifacts (id, workstream_id, turn_id, type, name, content, path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.workstream_id,
      data.turn_id ?? null,
      data.type,
      data.name,
      data.content ?? null,
      data.path ?? null,
      data.metadata_json ?? null,
    );
    return localArtifacts.getById(id)!;
  },

  getById(id: string): ArtifactRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  },

  getLatestByWorkstream(workstreamId: string, type?: string): ArtifactRow | undefined {
    const db = getDatabase();
    if (type) {
      return db.prepare(`
        SELECT * FROM artifacts
        WHERE workstream_id = ? AND type = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).get(workstreamId, type) as ArtifactRow | undefined;
    }

    return db.prepare(`
      SELECT * FROM artifacts
      WHERE workstream_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(workstreamId) as ArtifactRow | undefined;
  },

  listByWorkstream(workstreamId: string, limit = 50): ArtifactRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM artifacts
      WHERE workstream_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(workstreamId, limit) as ArtifactRow[];
  },

  listRecent(limit = 50, type?: string): ArtifactRow[] {
    const db = getDatabase();
    if (type) {
      return db.prepare(`
        SELECT * FROM artifacts
        WHERE type = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `).all(type, limit) as ArtifactRow[];
    }

    return db.prepare(`
      SELECT * FROM artifacts
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(limit) as ArtifactRow[];
  },
};

// --- Approvals ---

const localApprovals = {
  create(data: {
    workstream_id: string;
    turn_id?: string;
    type: string;
    description: string;
    context_json?: string;
    tier: string;
  }): ApprovalRow {
    const db = getDatabase();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO approvals (id, workstream_id, turn_id, type, description, context_json, tier)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.workstream_id,
      data.turn_id ?? null,
      data.type,
      data.description,
      data.context_json ?? null,
      data.tier
    );
    return localApprovals.getById(id)!;
  },

  getById(id: string): ApprovalRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  },

  listPending(workstreamId?: string): ApprovalRow[] {
    const db = getDatabase();
    if (workstreamId) {
      return db.prepare("SELECT * FROM approvals WHERE workstream_id = ? AND status = 'pending' ORDER BY created_at ASC")
        .all(workstreamId) as ApprovalRow[];
    }
    return db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as ApprovalRow[];
  },

  resolve(id: string, status: "approved" | "denied" | "expired", decidedBy: string): ApprovalRow | undefined {
    const db = getDatabase();
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
      .run(status, decidedBy, id);
    return localApprovals.getById(id);
  },

  expirePendingByWorkstream(workstreamId: string, decidedBy = "system"): number {
    const db = getDatabase();
    const result = db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_by = ?, decided_at = datetime('now') WHERE workstream_id = ? AND status = 'pending'"
      )
      .run(decidedBy, workstreamId);
    return result.changes;
  },
};

// --- Events ---

const localEvents = {
  emit(data: {
    workstream_id?: string;
    project_id?: string;
    event_type: string;
    payload: Record<string, unknown>;
    source: string;
  }): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO events (workstream_id, project_id, event_type, payload_json, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.workstream_id ?? null,
      data.project_id ?? null,
      data.event_type,
      JSON.stringify(data.payload),
      data.source
    );
  },

  listByWorkstream(workstreamId: string, limit = 50): EventRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM events WHERE workstream_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workstreamId, limit) as EventRow[];
  },

  listRecent(limit = 100): EventRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as EventRow[];
  },

  listByType(eventType: string, limit = 100): EventRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?")
      .all(eventType, limit) as EventRow[];
  },
};

// --- Assistant messages ---

const localAssistantMessages = {
  create(data: {
    id?: string;
    source: string;
    direction: string;
    contact?: string | null;
    project_id?: string | null;
    lane_id?: string | null;
    thread_id?: string | null;
    body: string;
    normalized_body: string;
    intent?: string | null;
    status?: string;
    metadata_json?: string | null;
  }): AssistantMessageRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_messages (
        id, source, direction, contact, project_id, lane_id, thread_id, body, normalized_body, intent, status, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.source,
      data.direction,
      data.contact ?? null,
      data.project_id ?? null,
      data.lane_id ?? null,
      data.thread_id ?? null,
      data.body,
      data.normalized_body,
      data.intent ?? null,
      data.status ?? "received",
      data.metadata_json ?? null
    );
    return localAssistantMessages.getById(id)!;
  },

  getById(id: string): AssistantMessageRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_messages WHERE id = ?").get(id) as AssistantMessageRow | undefined;
  },

  listRecent(limit = 100): AssistantMessageRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as AssistantMessageRow[];
  },

  update(id: string, fields: Partial<Pick<AssistantMessageRow, "intent" | "status" | "metadata_json">>): AssistantMessageRow | undefined {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) {
      return localAssistantMessages.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_messages SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localAssistantMessages.getById(id);
  },
};

// --- Assistant notes ---

const localAssistantNotes = {
  create(data: {
    id?: string;
    message_id?: string | null;
    source_contact?: string | null;
    title: string;
    content: string;
    note_context?: string;
    note_kind?: string | null;
    project_name?: string | null;
    smart_goal_ids_json?: string | null;
    attachments_json?: string | null;
    storage_path?: string | null;
    tags_json?: string | null;
  }): AssistantNoteRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_notes (
        id, message_id, source_contact, title, content, note_context, note_kind,
        project_name, smart_goal_ids_json, attachments_json, storage_path, tags_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.message_id ?? null,
      data.source_contact ?? null,
      data.title,
      data.content,
      data.note_context ?? "personal",
      data.note_kind ?? null,
      data.project_name ?? null,
      data.smart_goal_ids_json ?? null,
      data.attachments_json ?? null,
      data.storage_path ?? null,
      data.tags_json ?? null
    );
    return localAssistantNotes.getById(id)!;
  },

  getById(id: string): AssistantNoteRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_notes WHERE id = ?").get(id) as AssistantNoteRow | undefined;
  },

  listRecent(limit = 100): AssistantNoteRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_notes ORDER BY created_at DESC LIMIT ?")
      .all(limit) as AssistantNoteRow[];
  },

  update(
    id: string,
    fields: Partial<Pick<AssistantNoteRow, "title" | "content" | "note_context" | "note_kind" | "project_name" | "tags_json">>
  ): AssistantNoteRow | undefined {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) {
      return localAssistantNotes.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_notes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localAssistantNotes.getById(id);
  },
};

// --- Assistant tasks ---

const localAssistantTasks = {
  create(data: {
    id?: string;
    message_id?: string | null;
    source_contact?: string | null;
    title: string;
    details: string;
    primary_context?: string;
    status?: string;
    due_at?: string | null;
    scheduled_for?: string | null;
    note_id?: string | null;
    reminder_id?: string | null;
    calendar_event_id?: string | null;
    completed_at?: string | null;
  }): AssistantTaskRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_tasks (
        id, message_id, source_contact, title, details, primary_context, status, due_at, scheduled_for,
        note_id, reminder_id, calendar_event_id, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.message_id ?? null,
      data.source_contact ?? null,
      data.title,
      data.details,
      data.primary_context ?? "personal",
      data.status ?? "inbox",
      data.due_at ?? null,
      data.scheduled_for ?? null,
      data.note_id ?? null,
      data.reminder_id ?? null,
      data.calendar_event_id ?? null,
      data.completed_at ?? null
    );
    return localAssistantTasks.getById(id)!;
  },

  getById(id: string): AssistantTaskRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_tasks WHERE id = ?").get(id) as AssistantTaskRow | undefined;
  },

  listRecent(limit = 100): AssistantTaskRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_tasks
      ORDER BY
        CASE
          WHEN status = 'overdue' THEN 0
          WHEN status = 'inbox' THEN 1
          ELSE 2
        END,
        updated_at DESC
      LIMIT ?
    `).all(limit) as AssistantTaskRow[];
  },

  listByStatus(status: string, limit = 100): AssistantTaskRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_tasks
      WHERE status = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(status, limit) as AssistantTaskRow[];
  },

  update(
    id: string,
    fields: Partial<Pick<AssistantTaskRow,
      "title" | "details" | "primary_context" | "status" | "due_at" | "scheduled_for" |
      "note_id" | "reminder_id" | "calendar_event_id" | "completed_at"
    >>
  ): AssistantTaskRow | undefined {
    const db = getDatabase();
    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    values.push(id);
    db.prepare(`UPDATE assistant_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localAssistantTasks.getById(id);
  },
};

// --- Assistant calendar events ---

const localAssistantCalendarEvents = {
  create(data: {
    id?: string;
    message_id?: string | null;
    source_contact?: string | null;
    title: string;
    details?: string | null;
    starts_at: string;
    ends_at?: string | null;
    recurrence_rule?: string | null;
    timezone: string;
    location?: string | null;
    provider?: string;
    provider_event_id?: string | null;
    sync_status?: string;
    sync_error?: string | null;
  }): AssistantCalendarEventRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_calendar_events (
        id, message_id, source_contact, title, details, starts_at, ends_at, recurrence_rule, timezone, location,
        provider, provider_event_id, sync_status, sync_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.message_id ?? null,
      data.source_contact ?? null,
      data.title,
      data.details ?? null,
      data.starts_at,
      data.ends_at ?? null,
      data.recurrence_rule ?? null,
      data.timezone,
      data.location ?? null,
      data.provider ?? "memory",
      data.provider_event_id ?? null,
      data.sync_status ?? "pending",
      data.sync_error ?? null
    );
    return localAssistantCalendarEvents.getById(id)!;
  },

  getById(id: string): AssistantCalendarEventRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_calendar_events WHERE id = ?").get(id) as AssistantCalendarEventRow | undefined;
  },

  listRecent(limit = 100): AssistantCalendarEventRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_calendar_events ORDER BY starts_at ASC LIMIT ?")
      .all(limit) as AssistantCalendarEventRow[];
  },

  listUpcoming(referenceTime: string, limit = 100): AssistantCalendarEventRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_calendar_events
      WHERE starts_at >= ?
      ORDER BY starts_at ASC
      LIMIT ?
    `).all(referenceTime, limit) as AssistantCalendarEventRow[];
  },

  update(
    id: string,
    fields: Partial<Pick<AssistantCalendarEventRow, "provider" | "provider_event_id" | "sync_status" | "sync_error">>
  ): AssistantCalendarEventRow | undefined {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) {
      return localAssistantCalendarEvents.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_calendar_events SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localAssistantCalendarEvents.getById(id);
  },
};

// --- Assistant reminders ---

const localAssistantReminders = {
  create(data: {
    id?: string;
    message_id?: string | null;
    source_contact?: string | null;
    body: string;
    remind_at: string;
    channel?: string;
    destination?: string | null;
    provider?: string;
    status?: string;
  }): AssistantReminderRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_reminders (id, message_id, source_contact, body, remind_at, channel, destination, provider, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.message_id ?? null,
      data.source_contact ?? null,
      data.body,
      data.remind_at,
      data.channel ?? "sms",
      data.destination ?? null,
      data.provider ?? "disabled",
      data.status ?? "scheduled"
    );
    return localAssistantReminders.getById(id)!;
  },

  getById(id: string): AssistantReminderRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_reminders WHERE id = ?").get(id) as AssistantReminderRow | undefined;
  },

  listRecent(limit = 100): AssistantReminderRow[] {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_reminders ORDER BY remind_at ASC LIMIT ?")
      .all(limit) as AssistantReminderRow[];
  },

  listDue(referenceTime: string): AssistantReminderRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_reminders
      WHERE status = 'scheduled' AND remind_at <= ?
      ORDER BY remind_at ASC
    `).all(referenceTime) as AssistantReminderRow[];
  },

  update(
    id: string,
    fields: Partial<Pick<AssistantReminderRow, "body" | "remind_at" | "destination" | "status" | "error">>
  ): AssistantReminderRow | undefined {
    const db = getDatabase();
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) {
      return localAssistantReminders.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_reminders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localAssistantReminders.getById(id);
  },

  markSent(id: string, providerMessageId?: string | null): AssistantReminderRow | undefined {
    const db = getDatabase();
    db.prepare(`
      UPDATE assistant_reminders
      SET status = 'sent', sent_at = datetime('now'), provider_message_id = ?, error = NULL
      WHERE id = ?
    `).run(providerMessageId ?? null, id);
    return localAssistantReminders.getById(id);
  },

  markFailed(id: string, error: string): AssistantReminderRow | undefined {
    const db = getDatabase();
    db.prepare(`
      UPDATE assistant_reminders
      SET status = 'failed', error = ?
      WHERE id = ?
    `).run(error, id);
    return localAssistantReminders.getById(id);
  },
};

// --- Assistant settings ---

const localAssistantSettings = {
  upsert(data: {
    scope_type: string;
    scope_id: string;
    feature: string;
    profile: string;
  }): AssistantSettingRow {
    const db = getDatabase();
    const id = `${data.scope_type}:${data.scope_id}:${data.feature}`;
    db.prepare(`
      INSERT INTO assistant_settings (id, scope_type, scope_id, feature, profile)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        profile = excluded.profile,
        updated_at = datetime('now')
    `).run(id, data.scope_type, data.scope_id, data.feature, data.profile);
    return localAssistantSettings.getById(id)!;
  },

  getById(id: string): AssistantSettingRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM assistant_settings WHERE id = ?").get(id) as AssistantSettingRow | undefined;
  },

  get(scopeType: string, scopeId: string, feature: string): AssistantSettingRow | undefined {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_settings
      WHERE scope_type = ? AND scope_id = ? AND feature = ?
      LIMIT 1
    `).get(scopeType, scopeId, feature) as AssistantSettingRow | undefined;
  },

  list(): AssistantSettingRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_settings
      ORDER BY scope_type ASC, scope_id ASC, feature ASC
    `).all() as AssistantSettingRow[];
  },
};

// --- Dashboard item assignments ---

const localAssistantItemAssignments = {
  upsert(data: {
    item_type: string;
    item_id: string;
    project_id: string;
    lane_id?: string | null;
    updated_by?: string;
  }): AssistantItemAssignmentRow {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO assistant_item_assignments (item_type, item_id, project_id, lane_id, updated_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_type, item_id) DO UPDATE SET
        project_id = excluded.project_id,
        lane_id = excluded.lane_id,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      data.item_type,
      data.item_id,
      data.project_id,
      data.lane_id ?? null,
      data.updated_by ?? "dashboard"
    );
    return localAssistantItemAssignments.get(data.item_type, data.item_id)!;
  },

  get(itemType: string, itemId: string): AssistantItemAssignmentRow | undefined {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_item_assignments
      WHERE item_type = ? AND item_id = ?
    `).get(itemType, itemId) as AssistantItemAssignmentRow | undefined;
  },

  list(): AssistantItemAssignmentRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_item_assignments
      ORDER BY updated_at DESC
    `).all() as AssistantItemAssignmentRow[];
  },

  listByProject(projectId: string): AssistantItemAssignmentRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM assistant_item_assignments
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(projectId) as AssistantItemAssignmentRow[];
  },

  delete(itemType: string, itemId: string): boolean {
    const db = getDatabase();
    const result = db.prepare(`
      DELETE FROM assistant_item_assignments
      WHERE item_type = ? AND item_id = ?
    `).run(itemType, itemId);
    return result.changes > 0;
  },
};

// --- Dashboard daily plan items ---

const localDashboardPlanItems = {
  create(data: {
    id?: string;
    date_key: string;
    section: string;
    item_type?: string | null;
    item_id?: string | null;
    title: string;
    details?: string | null;
    project_id?: string | null;
    lane_id?: string | null;
    position?: number;
    status?: string;
  }): DashboardPlanItemRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO dashboard_plan_items (
        id, date_key, section, item_type, item_id, title, details, project_id, lane_id, position, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.date_key,
      data.section,
      data.item_type ?? null,
      data.item_id ?? null,
      data.title,
      data.details ?? null,
      data.project_id ?? null,
      data.lane_id ?? null,
      data.position ?? 0,
      data.status ?? "active"
    );
    return localDashboardPlanItems.getById(id)!;
  },

  getById(id: string): DashboardPlanItemRow | undefined {
    const db = getDatabase();
    return db.prepare("SELECT * FROM dashboard_plan_items WHERE id = ?").get(id) as DashboardPlanItemRow | undefined;
  },

  listByDate(dateKey: string): DashboardPlanItemRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM dashboard_plan_items
      WHERE date_key = ?
      ORDER BY section ASC, position ASC, created_at ASC
    `).all(dateKey) as DashboardPlanItemRow[];
  },

  update(
    id: string,
    fields: Partial<Pick<DashboardPlanItemRow,
      "date_key" | "section" | "item_type" | "item_id" | "title" | "details" |
      "project_id" | "lane_id" | "position" | "status"
    >>
  ): DashboardPlanItemRow | undefined {
    const db = getDatabase();
    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
    }

    values.push(id);
    db.prepare(`UPDATE dashboard_plan_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return localDashboardPlanItems.getById(id);
  },

  delete(id: string): boolean {
    const db = getDatabase();
    const result = db.prepare("DELETE FROM dashboard_plan_items WHERE id = ?").run(id);
    return result.changes > 0;
  },
};

// --- Per-instance runtime bindings ---

const localWorkstreamRuntimeBindings = {
  upsert(data: {
    workstream_id: string;
    instance_id?: string;
    cwd?: string | null;
    codex_thread_id?: string | null;
    runtime_status?: string;
  }): WorkstreamRuntimeBindingRow {
    const db = getDatabase();
    const instanceId = data.instance_id ?? getRuntimeInstanceId();
    db.prepare(`
      INSERT INTO workstream_runtime_bindings (
        workstream_id, instance_id, cwd, codex_thread_id, runtime_status, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(workstream_id, instance_id) DO UPDATE SET
        cwd = excluded.cwd,
        codex_thread_id = excluded.codex_thread_id,
        runtime_status = excluded.runtime_status,
        updated_at = datetime('now'),
        last_seen_at = datetime('now')
    `).run(
      data.workstream_id,
      instanceId,
      data.cwd ?? null,
      data.codex_thread_id ?? null,
      data.runtime_status ?? "idle",
    );

    return localWorkstreamRuntimeBindings.get(data.workstream_id, instanceId)!;
  },

  get(workstreamId: string, instanceId = getRuntimeInstanceId()): WorkstreamRuntimeBindingRow | undefined {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM workstream_runtime_bindings
      WHERE workstream_id = ? AND instance_id = ?
    `).get(workstreamId, instanceId) as WorkstreamRuntimeBindingRow | undefined;
  },

  listByWorkstream(workstreamId: string): WorkstreamRuntimeBindingRow[] {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM workstream_runtime_bindings
      WHERE workstream_id = ?
      ORDER BY last_seen_at DESC, instance_id ASC
    `).all(workstreamId) as WorkstreamRuntimeBindingRow[];
  },

  markStatus(workstreamId: string, status: string, instanceId = getRuntimeInstanceId()): WorkstreamRuntimeBindingRow | undefined {
    const db = getDatabase();
    db.prepare(`
      UPDATE workstream_runtime_bindings
      SET runtime_status = ?, updated_at = datetime('now'), last_seen_at = datetime('now')
      WHERE workstream_id = ? AND instance_id = ?
    `).run(status, workstreamId, instanceId);
    return localWorkstreamRuntimeBindings.get(workstreamId, instanceId);
  },
};

// --- Active operation guards ---

const localActiveWorkstreamOperations = {
  begin(data: {
    workstream_id: string;
    operation_kind: string;
    owner_instance_id?: string;
    started_at?: string;
  }): ActiveWorkstreamOperationRow {
    const db = getDatabase();
    const owner = data.owner_instance_id ?? getRuntimeInstanceId();
    const startedAt = data.started_at ?? new Date().toISOString();
    const existing = localActiveWorkstreamOperations.get(data.workstream_id);
    if (existing && existing.status === "running" && existing.owner_instance_id !== owner) {
      throw new Error(
        `Workstream ${data.workstream_id} is already running ${existing.operation_kind} on ${existing.owner_instance_id}.`
      );
    }

    db.prepare(`
      INSERT INTO active_workstream_operations (
        workstream_id, operation_kind, owner_instance_id, status, started_at, last_seen_at
      )
      VALUES (?, ?, ?, 'running', ?, ?)
      ON CONFLICT(workstream_id) DO UPDATE SET
        operation_kind = excluded.operation_kind,
        owner_instance_id = excluded.owner_instance_id,
        status = 'running',
        started_at = excluded.started_at,
        last_seen_at = excluded.last_seen_at,
        completed_at = NULL
    `).run(data.workstream_id, data.operation_kind, owner, startedAt, startedAt);

    return localActiveWorkstreamOperations.get(data.workstream_id)!;
  },

  get(workstreamId: string): ActiveWorkstreamOperationRow | undefined {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM active_workstream_operations
      WHERE workstream_id = ? AND status = 'running'
    `).get(workstreamId) as ActiveWorkstreamOperationRow | undefined;
  },

  touch(
    workstreamId: string,
    operationKind: string,
    ownerInstanceId = getRuntimeInstanceId(),
    at = new Date().toISOString(),
  ): ActiveWorkstreamOperationRow {
    const existing = localActiveWorkstreamOperations.get(workstreamId);
    if (existing && existing.owner_instance_id !== ownerInstanceId) {
      throw new Error(
        `Workstream ${workstreamId} is already running ${existing.operation_kind} on ${existing.owner_instance_id}.`
      );
    }

    if (!existing) {
      return localActiveWorkstreamOperations.begin({
        workstream_id: workstreamId,
        operation_kind: operationKind,
        owner_instance_id: ownerInstanceId,
        started_at: at,
      });
    }

    const db = getDatabase();
    db.prepare(`
      UPDATE active_workstream_operations
      SET operation_kind = ?, last_seen_at = ?
      WHERE workstream_id = ? AND owner_instance_id = ? AND status = 'running'
    `).run(operationKind, at, workstreamId, ownerInstanceId);
    return localActiveWorkstreamOperations.get(workstreamId)!;
  },

  complete(workstreamId: string, ownerInstanceId = getRuntimeInstanceId()): void {
    const db = getDatabase();
    db.prepare(`
      UPDATE active_workstream_operations
      SET status = 'completed', completed_at = ?, last_seen_at = ?
      WHERE workstream_id = ? AND owner_instance_id = ? AND status = 'running'
    `).run(new Date().toISOString(), new Date().toISOString(), workstreamId, ownerInstanceId);
  },

  clear(workstreamId: string): number {
    const db = getDatabase();
    const result = db.prepare(`
      UPDATE active_workstream_operations
      SET status = 'completed', completed_at = datetime('now'), last_seen_at = datetime('now')
      WHERE workstream_id = ? AND status = 'running'
    `).run(workstreamId);
    return result.changes;
  },

  clearForOwner(ownerInstanceId = getRuntimeInstanceId()): number {
    const db = getDatabase();
    const result = db.prepare(`
      UPDATE active_workstream_operations
      SET status = 'completed', completed_at = datetime('now'), last_seen_at = datetime('now')
      WHERE owner_instance_id = ? AND status = 'running'
    `).run(ownerInstanceId);
    return result.changes;
  },
};

const localRepositories = {
  projects: localProjects,
  workstreams: localWorkstreams,
  turns: localTurns,
  artifacts: localArtifacts,
  approvals: localApprovals,
  events: localEvents,
  discordThreadBindings: localDiscordThreadBindings,
  assistantMessages: localAssistantMessages,
  assistantNotes: localAssistantNotes,
  assistantTasks: localAssistantTasks,
  assistantCalendarEvents: localAssistantCalendarEvents,
  assistantReminders: localAssistantReminders,
  assistantSettings: localAssistantSettings,
  assistantItemAssignments: localAssistantItemAssignments,
  dashboardPlanItems: localDashboardPlanItems,
  workstreamRuntimeBindings: localWorkstreamRuntimeBindings,
  activeWorkstreamOperations: localActiveWorkstreamOperations,
};

type StateRepositories = typeof localRepositories;
export type StateRepositoryName = keyof StateRepositories;

export function invokeLocalStateOperation(
  repository: string,
  method: string,
  args: unknown[],
): unknown {
  if (!isStateRepositoryName(repository)) {
    throw new Error(`Unknown state repository: ${repository}`);
  }

  const repo = localRepositories[repository] as Record<string, unknown>;
  const operation = repo[method];
  if (typeof operation !== "function") {
    throw new Error(`Unknown state operation: ${repository}.${method}`);
  }

  return operation(...args);
}

export const projects = createRepositoryProxy("projects", localProjects);
export const workstreams = createRepositoryProxy("workstreams", localWorkstreams);
export const turns = createRepositoryProxy("turns", localTurns);
export const artifacts = createRepositoryProxy("artifacts", localArtifacts);
export const approvals = createRepositoryProxy("approvals", localApprovals);
export const events = createRepositoryProxy("events", localEvents);
export const discordThreadBindings = createRepositoryProxy("discordThreadBindings", localDiscordThreadBindings);
export const assistantMessages = createRepositoryProxy("assistantMessages", localAssistantMessages);
export const assistantNotes = createRepositoryProxy("assistantNotes", localAssistantNotes);
export const assistantTasks = createRepositoryProxy("assistantTasks", localAssistantTasks);
export const assistantCalendarEvents = createRepositoryProxy("assistantCalendarEvents", localAssistantCalendarEvents);
export const assistantReminders = createRepositoryProxy("assistantReminders", localAssistantReminders);
export const assistantSettings = createRepositoryProxy("assistantSettings", localAssistantSettings);
export const assistantItemAssignments = createRepositoryProxy("assistantItemAssignments", localAssistantItemAssignments);
export const dashboardPlanItems = createRepositoryProxy("dashboardPlanItems", localDashboardPlanItems);
export const workstreamRuntimeBindings = createRepositoryProxy("workstreamRuntimeBindings", localWorkstreamRuntimeBindings);
export const activeWorkstreamOperations = createRepositoryProxy("activeWorkstreamOperations", localActiveWorkstreamOperations);

function createRepositoryProxy<TRepository extends object>(
  repositoryName: StateRepositoryName,
  localRepository: TRepository,
): TRepository {
  return new Proxy(localRepository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        if (getStateBackendMode() === "remote") {
          return invokeRemoteStateOperation(repositoryName, property, args);
        }

        return (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as TRepository;
}

function isStateRepositoryName(value: string): value is StateRepositoryName {
  return Object.prototype.hasOwnProperty.call(localRepositories, value);
}
