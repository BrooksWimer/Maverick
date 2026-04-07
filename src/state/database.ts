/**
 * Database connection and migration management.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("database");
const __dirname = dirname(fileURLToPath(import.meta.url));

type SqliteDatabase = ReturnType<typeof Database>;

let db: SqliteDatabase | null = null;

function ensureColumn(database: SqliteDatabase, tableName: string, columnName: string, alterSql: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  database.exec(alterSql);
  log.info({ tableName, columnName }, "Database column added");
}

function ensureIndex(database: SqliteDatabase, indexName: string, createSql: string): void {
  const index = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { name: string } | undefined;
  if (index) {
    return;
  }

  database.exec(createSql);
  log.info({ indexName }, "Database index added");
}

function resolveSchemaPath(): string {
  const candidates = [
    resolve(__dirname, "schema.sql"),
    resolve(process.cwd(), "src", "state", "schema.sql"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find database schema. Checked: ${candidates.join(", ")}`);
}

export function getDatabase(): SqliteDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function initDatabase(dbPath?: string): SqliteDatabase {
  const resolvedPath = dbPath ?? process.env.DATABASE_PATH ?? "./data/orchestrator.db";

  // Ensure parent directory exists
  const dir = dirname(resolve(resolvedPath));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  log.info({ path: resolvedPath }, "Initializing database");

  db = new Database(resolvedPath);

  // Apply schema
  const schemaPath = resolveSchemaPath();
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
  ensureColumn(db, "workstreams", "epic_id", "ALTER TABLE workstreams ADD COLUMN epic_id TEXT");
  ensureColumn(
    db,
    "assistant_notes",
    "note_context",
    "ALTER TABLE assistant_notes ADD COLUMN note_context TEXT NOT NULL DEFAULT 'general'"
  );
  ensureColumn(db, "assistant_notes", "note_kind", "ALTER TABLE assistant_notes ADD COLUMN note_kind TEXT");
  ensureColumn(db, "assistant_notes", "project_name", "ALTER TABLE assistant_notes ADD COLUMN project_name TEXT");
  ensureColumn(
    db,
    "assistant_notes",
    "smart_goal_ids_json",
    "ALTER TABLE assistant_notes ADD COLUMN smart_goal_ids_json TEXT"
  );
  ensureColumn(
    db,
    "assistant_notes",
    "attachments_json",
    "ALTER TABLE assistant_notes ADD COLUMN attachments_json TEXT"
  );
  ensureColumn(
    db,
    "assistant_notes",
    "storage_path",
    "ALTER TABLE assistant_notes ADD COLUMN storage_path TEXT"
  );
  ensureIndex(
    db,
    "idx_assistant_notes_project_name",
    "CREATE INDEX IF NOT EXISTS idx_assistant_notes_project_name ON assistant_notes(project_name)"
  );

  log.info({ schemaPath }, "Database schema applied");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info("Database closed");
  }
}
