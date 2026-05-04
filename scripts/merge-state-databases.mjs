#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(repoRoot, "src", "state", "schema.sql");

const tableCopyOrder = [
  "projects",
  "workstreams",
  "discord_thread_bindings",
  "turns",
  "approvals",
  "decisions",
  "artifacts",
  "events",
  "assistant_messages",
  "assistant_notes",
  "assistant_tasks",
  "assistant_calendar_events",
  "assistant_reminders",
  "assistant_settings",
  "assistant_item_assignments",
  "dashboard_plan_items",
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const canonicalPath = args.canonical ?? args["linux-db"];
const sourcePath = args.source ?? args["windows-db"];
if (!canonicalPath || !sourcePath) {
  printHelp();
  process.exit(1);
}

const reportPath = args.report ?? resolve(process.cwd(), "maverick-state-merge-report.json");
const canonicalInstance = args["canonical-instance"] ?? "linux";
const sourceInstance = args["source-instance"] ?? "windows";
const dryRun = Boolean(args["dry-run"]);

if (!existsSync(canonicalPath)) {
  throw new Error(`Canonical database not found: ${canonicalPath}`);
}
if (!existsSync(sourcePath)) {
  throw new Error(`Source database not found: ${sourcePath}`);
}

const canonical = new Database(canonicalPath);
const source = new Database(sourcePath, { readonly: true });

const report = {
  canonical: resolve(canonicalPath),
  source: resolve(sourcePath),
  canonicalInstance,
  sourceInstance,
  dryRun,
  imported: {},
  skippedMissingTables: [],
  remappedEvents: 0,
  runtimeBindings: {
    canonical: 0,
    source: 0,
  },
  conflicts: [],
};

try {
  canonical.pragma("foreign_keys = OFF");
  canonical.exec(readFileSync(schemaPath, "utf8"));

  canonical.exec("BEGIN");
  try {
    materializeRuntimeBindings(canonical, canonical, canonicalInstance, "canonical", report);

    for (const table of tableCopyOrder) {
      copyMissingRows({ source, destination: canonical, table, report });
    }

    materializeRuntimeBindings(source, canonical, sourceInstance, "source", report);

    if (dryRun) {
      canonical.exec("ROLLBACK");
    } else {
      canonical.exec("COMMIT");
    }
  } catch (error) {
    canonical.exec("ROLLBACK");
    throw error;
  }
} finally {
  source.close();
  canonical.close();
}

mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  `${dryRun ? "Dry run complete" : "Merge complete"}: report written to ${resolve(reportPath)}`
);

function copyMissingRows({ source, destination, table, report }) {
  if (!tableExists(source, table) || !tableExists(destination, table)) {
    report.skippedMissingTables.push(table);
    return;
  }

  const sourceColumns = columnsFor(source, table);
  const destinationColumns = columnsFor(destination, table);
  const destinationColumnNames = new Set(destinationColumns.map((column) => column.name));
  const commonColumns = sourceColumns
    .map((column) => column.name)
    .filter((columnName) => destinationColumnNames.has(columnName));
  const primaryKey = destinationColumns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name)
    .filter((columnName) => commonColumns.includes(columnName));

  if (commonColumns.length === 0 || primaryKey.length === 0) {
    report.skippedMissingTables.push(table);
    return;
  }

  const rows = source.prepare(`SELECT ${commonColumns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`).all();
  let imported = 0;

  for (const row of rows) {
    const existing = findByPrimaryKey(destination, table, primaryKey, row);
    if (existing) {
      if (table === "events") {
        const eventColumns = commonColumns.filter((columnName) => columnName !== "id");
        insertRow(destination, table, eventColumns, row);
        imported += 1;
        report.remappedEvents += 1;
      } else {
        report.conflicts.push({
          table,
          primaryKey: pick(row, primaryKey),
          action: "kept-canonical",
        });
      }
      continue;
    }

    try {
      insertRow(destination, table, commonColumns, row);
      imported += 1;
    } catch (error) {
      report.conflicts.push({
        table,
        primaryKey: pick(row, primaryKey),
        action: "insert-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  report.imported[table] = imported;
}

function materializeRuntimeBindings(sourceDb, destinationDb, instanceId, reportKey, report) {
  if (!tableExists(sourceDb, "workstreams") || !tableExists(destinationDb, "workstream_runtime_bindings")) {
    return;
  }

  const workstreamColumns = new Set(columnsFor(sourceDb, "workstreams").map((column) => column.name));
  if (!workstreamColumns.has("id") || !workstreamColumns.has("cwd") || !workstreamColumns.has("codex_thread_id")) {
    return;
  }

  const rows = sourceDb
    .prepare("SELECT id, cwd, codex_thread_id FROM workstreams WHERE cwd IS NOT NULL OR codex_thread_id IS NOT NULL")
    .all();
  let created = 0;

  for (const row of rows) {
    const destinationWorkstream = destinationDb
      .prepare("SELECT id FROM workstreams WHERE id = ?")
      .get(row.id);
    if (!destinationWorkstream) {
      report.conflicts.push({
        table: "workstream_runtime_bindings",
        primaryKey: { workstream_id: row.id, instance_id: instanceId },
        action: "missing-durable-workstream",
      });
      continue;
    }

    destinationDb.prepare(`
      INSERT INTO workstream_runtime_bindings (
        workstream_id, instance_id, cwd, codex_thread_id, runtime_status, last_seen_at
      )
      VALUES (?, ?, ?, ?, 'idle', datetime('now'))
      ON CONFLICT(workstream_id, instance_id) DO UPDATE SET
        cwd = excluded.cwd,
        codex_thread_id = excluded.codex_thread_id,
        updated_at = datetime('now'),
        last_seen_at = datetime('now')
    `).run(row.id, instanceId, row.cwd ?? null, row.codex_thread_id ?? null);
    created += 1;
  }

  report.runtimeBindings[reportKey] = created;
}

function tableExists(database, table) {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );
}

function columnsFor(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

function findByPrimaryKey(database, table, primaryKey, row) {
  const where = primaryKey.map((columnName) => `${quoteIdent(columnName)} = ?`).join(" AND ");
  return database
    .prepare(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`)
    .get(...primaryKey.map((columnName) => row[columnName]));
}

function insertRow(database, table, columns, row) {
  const placeholders = columns.map(() => "?").join(", ");
  database
    .prepare(`INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`)
    .run(...columns.map((columnName) => row[columnName]));
}

function pick(row, keys) {
  return Object.fromEntries(keys.map((key) => [key, row[key]]));
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === "dry-run" || rawKey === "help") {
      parsed[rawKey] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    parsed[rawKey] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/merge-state-databases.mjs --canonical /var/lib/maverick/orchestrator.db --source ./data/orchestrator.db [options]

Options:
  --linux-db <path>             Alias for --canonical
  --windows-db <path>           Alias for --source
  --canonical-instance <id>     Runtime binding instance for canonical cwd/thread fields (default: linux)
  --source-instance <id>        Runtime binding instance for source cwd/thread fields (default: windows)
  --report <path>               Conflict/import report path (default: ./maverick-state-merge-report.json)
  --dry-run                     Roll back after producing the report
`);
}
