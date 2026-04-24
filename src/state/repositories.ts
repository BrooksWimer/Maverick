/**
 * Repository pattern for database access.
 * Each entity gets typed CRUD methods that return plain objects.
 */
import { randomUUID } from "node:crypto";
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
  codex_thread_id: string | null;
  execution_backend: string;
  discord_channel_id: string | null;
  discord_thread_id: string | null;
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
  body: string;
  normalized_body: string;
  intent: string | null;
  status: string;
  metadata_json: string | null;
  created_at: string;
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

// --- Projects ---

export const projects = {
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

    return projects.getById(data.id)!;
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

export const workstreams = {
  create(data: {
    id?: string;
    project_id: string;
    epic_id?: string;
    name: string;
    description?: string;
    cwd?: string;
    branch?: string;
    execution_backend?: string;
    discord_channel_id?: string;
  }): WorkstreamRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO workstreams (id, project_id, epic_id, name, description, cwd, branch, execution_backend, discord_channel_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.project_id,
      data.epic_id ?? null,
      data.name,
      data.description ?? null,
      data.cwd ?? null,
      data.branch ?? null,
      data.execution_backend ?? "codex-app-server",
      data.discord_channel_id ?? null
    );
    return workstreams.getById(id)!;
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
    return db.prepare("SELECT * FROM workstreams WHERE discord_channel_id = ? ORDER BY last_activity_at DESC")
      .all(channelId) as WorkstreamRow[];
  },

  update(id: string, fields: Partial<Pick<WorkstreamRow,
    "state" | "current_goal" | "cwd" | "branch" | "codex_thread_id" |
    "discord_channel_id" | "discord_thread_id" | "waiting_on_approval" |
    "pending_decision" | "summary" | "plan" | "planning_context_json" | "verification_context_json" | "completed_at"
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
    return workstreams.getById(id);
  },
};

// --- Turns ---

export const turns = {
  create(data: { workstream_id: string; instruction: string }): TurnRow {
    const db = getDatabase();
    const id = randomUUID();
    db.prepare("INSERT INTO turns (id, workstream_id, instruction) VALUES (?, ?, ?)")
      .run(id, data.workstream_id, data.instruction);
    return turns.getById(id)!;
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

    if (sets.length === 0) return turns.getById(id);
    values.push(id);
    db.prepare(`UPDATE turns SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return turns.getById(id);
  },
};

// --- Artifacts ---

export const artifacts = {
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
    return artifacts.getById(id)!;
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

export const approvals = {
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
    return approvals.getById(id)!;
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
    return approvals.getById(id);
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

export const events = {
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

export const assistantMessages = {
  create(data: {
    id?: string;
    source: string;
    direction: string;
    contact?: string | null;
    body: string;
    normalized_body: string;
    intent?: string | null;
    status?: string;
    metadata_json?: string | null;
  }): AssistantMessageRow {
    const db = getDatabase();
    const id = data.id ?? randomUUID();
    db.prepare(`
      INSERT INTO assistant_messages (id, source, direction, contact, body, normalized_body, intent, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.source,
      data.direction,
      data.contact ?? null,
      data.body,
      data.normalized_body,
      data.intent ?? null,
      data.status ?? "received",
      data.metadata_json ?? null
    );
    return assistantMessages.getById(id)!;
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
      return assistantMessages.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_messages SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return assistantMessages.getById(id);
  },
};

// --- Assistant notes ---

export const assistantNotes = {
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
    return assistantNotes.getById(id)!;
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
      return assistantNotes.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_notes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return assistantNotes.getById(id);
  },
};

// --- Assistant tasks ---

export const assistantTasks = {
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
    return assistantTasks.getById(id)!;
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
    return assistantTasks.getById(id);
  },
};

// --- Assistant calendar events ---

export const assistantCalendarEvents = {
  create(data: {
    id?: string;
    message_id?: string | null;
    source_contact?: string | null;
    title: string;
    details?: string | null;
    starts_at: string;
    ends_at?: string | null;
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
        id, message_id, source_contact, title, details, starts_at, ends_at, timezone, location,
        provider, provider_event_id, sync_status, sync_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.message_id ?? null,
      data.source_contact ?? null,
      data.title,
      data.details ?? null,
      data.starts_at,
      data.ends_at ?? null,
      data.timezone,
      data.location ?? null,
      data.provider ?? "memory",
      data.provider_event_id ?? null,
      data.sync_status ?? "pending",
      data.sync_error ?? null
    );
    return assistantCalendarEvents.getById(id)!;
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
      return assistantCalendarEvents.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_calendar_events SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return assistantCalendarEvents.getById(id);
  },
};

// --- Assistant reminders ---

export const assistantReminders = {
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
    return assistantReminders.getById(id)!;
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
      return assistantReminders.getById(id);
    }

    values.push(id);
    db.prepare(`UPDATE assistant_reminders SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return assistantReminders.getById(id);
  },

  markSent(id: string, providerMessageId?: string | null): AssistantReminderRow | undefined {
    const db = getDatabase();
    db.prepare(`
      UPDATE assistant_reminders
      SET status = 'sent', sent_at = datetime('now'), provider_message_id = ?, error = NULL
      WHERE id = ?
    `).run(providerMessageId ?? null, id);
    return assistantReminders.getById(id);
  },

  markFailed(id: string, error: string): AssistantReminderRow | undefined {
    const db = getDatabase();
    db.prepare(`
      UPDATE assistant_reminders
      SET status = 'failed', error = ?
      WHERE id = ?
    `).run(error, id);
    return assistantReminders.getById(id);
  },
};

// --- Assistant settings ---

export const assistantSettings = {
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
    return assistantSettings.getById(id)!;
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
