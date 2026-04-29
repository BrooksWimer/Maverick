import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  configureRemoteStateBackend,
  configureSqliteStateBackend,
  getDatabase,
  initDatabase,
  projects,
} from "../../src/state/index.js";

describe("initDatabase legacy migrations", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boots an older assistant_notes table before creating the project_name index", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE assistant_messages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        direction TEXT NOT NULL,
        contact TEXT,
        body TEXT NOT NULL,
        normalized_body TEXT NOT NULL,
        intent TEXT,
        status TEXT NOT NULL DEFAULT 'received',
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE assistant_notes (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES assistant_messages(id),
        source_contact TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacyDb.close();

    initDatabase(dbPath);

    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info(assistant_notes)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "project_name")).toBe(true);

    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_assistant_notes_project_name") as { name: string } | undefined;
    expect(index?.name).toBe("idx_assistant_notes_project_name");
  });

  it("adds the turns.last_progress_at column for older databases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE workstreams (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        epic_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        state TEXT NOT NULL DEFAULT 'intake',
        current_goal TEXT,
        cwd TEXT,
        branch TEXT,
        codex_thread_id TEXT,
        execution_backend TEXT NOT NULL DEFAULT 'codex-cli',
        discord_channel_id TEXT,
        discord_thread_id TEXT,
        waiting_on_approval INTEGER NOT NULL DEFAULT 0,
        pending_decision TEXT,
        summary TEXT,
        plan TEXT,
        planning_context_json TEXT,
        verification_context_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL REFERENCES workstreams(id),
        instruction TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacyDb.close();

    initDatabase(dbPath);

    const db = getDatabase();
    const columns = db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "last_progress_at")).toBe(true);
  });

  it("does not open a SQLite file when configured for remote state", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);
    const previousBackend = process.env.STATE_BACKEND;
    const previousUrl = process.env.MAVERICK_STATE_URL;
    const previousToken = process.env.MAVERICK_STATE_TOKEN;

    try {
      process.env.STATE_BACKEND = "remote";
      process.env.MAVERICK_STATE_URL = "http://127.0.0.1:9";
      process.env.MAVERICK_STATE_TOKEN = "test-token";

      expect(initDatabase(join(tempDir, "orchestrator.db"))).toBeNull();
      expect(() => getDatabase()).toThrow(/Database not initialized/);
    } finally {
      process.env.STATE_BACKEND = previousBackend;
      process.env.MAVERICK_STATE_URL = previousUrl;
      process.env.MAVERICK_STATE_TOKEN = previousToken;
      configureSqliteStateBackend();
    }
  });

  it("fails closed when remote state is unavailable", () => {
    configureRemoteStateBackend({
      url: "http://127.0.0.1:9",
      token: "test-token",
      timeoutMs: 1_000,
    });

    try {
      expect(() => projects.list()).toThrow(/Remote Maverick state operation failed/);
    } finally {
      configureSqliteStateBackend();
    }
  });
});
