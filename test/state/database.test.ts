import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../../src/state/index.js";

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
});
