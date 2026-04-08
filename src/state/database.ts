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

function ensureColumn(database: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
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
  ensureColumn(db, "workstreams", "plan", "TEXT");

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
