import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

describe("merge-state-databases", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Linux duplicate rows while importing Windows-only state and runtime bindings", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-merge-"));
    tempDirs.push(tempDir);
    const linuxDbPath = join(tempDir, "linux.db");
    const windowsDbPath = join(tempDir, "windows.db");
    const reportPath = join(tempDir, "report.json");
    const schema = readFileSync(resolve("src/state/schema.sql"), "utf8");

    const linux = new Database(linuxDbPath);
    linux.exec(schema);
    linux.prepare("INSERT INTO projects (id, name, repo_path, config_json) VALUES (?, ?, ?, ?)").run(
      "maverick",
      "Maverick",
      "/srv/maverick/app",
      "{}"
    );
    linux.prepare(`
      INSERT INTO workstreams (id, project_id, name, cwd, codex_thread_id, branch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("shared", "maverick", "Linux shared", "/srv/shared", "linux-thread", "maverick/maverick/shared");
    linux.prepare("INSERT INTO events (workstream_id, event_type, payload_json, source) VALUES (?, ?, ?, ?)").run(
      "shared",
      "linux.event",
      "{}",
      "linux"
    );
    linux.close();

    const windows = new Database(windowsDbPath);
    windows.exec(schema);
    windows.prepare("INSERT INTO projects (id, name, repo_path, config_json) VALUES (?, ?, ?, ?)").run(
      "maverick",
      "Maverick",
      "C:/Users/wimer/Desktop/Maverick",
      "{}"
    );
    windows.prepare(`
      INSERT INTO workstreams (id, project_id, name, cwd, codex_thread_id, branch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("shared", "maverick", "Windows duplicate", "C:/shared", "windows-thread", "maverick/maverick/shared");
    windows.prepare(`
      INSERT INTO workstreams (id, project_id, name, cwd, codex_thread_id, branch)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("windows-only", "maverick", "Windows only", "C:/only", "windows-only-thread", "maverick/maverick/windows-only");
    windows.prepare("INSERT INTO turns (id, workstream_id, instruction, status) VALUES (?, ?, ?, ?)").run(
      "turn-windows",
      "windows-only",
      "continue",
      "completed"
    );
    windows.prepare(`
      INSERT INTO discord_thread_bindings (thread_id, parent_channel_id, project_id, lane, owner_instance_id)
      VALUES (?, ?, ?, ?, ?)
    `).run("thread-windows", "forum", "maverick", "ops", "linux");
    windows.prepare("INSERT INTO events (workstream_id, event_type, payload_json, source) VALUES (?, ?, ?, ?)").run(
      "windows-only",
      "windows.event",
      "{}",
      "windows"
    );
    windows.close();

    execFileSync(process.execPath, [
      "scripts/merge-state-databases.mjs",
      "--canonical",
      linuxDbPath,
      "--source",
      windowsDbPath,
      "--report",
      reportPath,
    ], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const merged = new Database(linuxDbPath, { readonly: true });
    try {
      const shared = merged.prepare("SELECT name, cwd, codex_thread_id FROM workstreams WHERE id = ?").get("shared") as {
        name: string;
        cwd: string;
        codex_thread_id: string;
      };
      expect(shared.name).toBe("Linux shared");
      expect(shared.cwd).toBe("/srv/shared");
      expect(shared.codex_thread_id).toBe("linux-thread");

      expect(merged.prepare("SELECT id FROM workstreams WHERE id = ?").get("windows-only")).toBeTruthy();
      expect(merged.prepare("SELECT id FROM turns WHERE id = ?").get("turn-windows")).toBeTruthy();
      expect(merged.prepare("SELECT thread_id FROM discord_thread_bindings WHERE thread_id = ?").get("thread-windows")).toBeTruthy();
      expect(merged.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
      expect(
        merged
          .prepare("SELECT cwd, codex_thread_id FROM workstream_runtime_bindings WHERE workstream_id = ? AND instance_id = ?")
          .get("shared", "windows")
      ).toEqual({ cwd: "C:/shared", codex_thread_id: "windows-thread" });
      expect(
        merged
          .prepare("SELECT cwd, codex_thread_id FROM workstream_runtime_bindings WHERE workstream_id = ? AND instance_id = ?")
          .get("shared", "linux")
      ).toEqual({ cwd: "/srv/shared", codex_thread_id: "linux-thread" });
    } finally {
      merged.close();
    }

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      conflicts: Array<{ table: string; primaryKey: Record<string, unknown>; action: string }>;
    };
    expect(report.conflicts).toContainEqual({
      table: "workstreams",
      primaryKey: { id: "shared" },
      action: "kept-canonical",
    });
  });
});
