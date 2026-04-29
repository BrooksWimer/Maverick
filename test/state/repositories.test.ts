import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeWorkstreamOperations,
  closeDatabase,
  discordThreadBindings,
  getDatabase,
  initDatabase,
  turns,
  workstreamRuntimeBindings,
  workstreams,
} from "../../src/state/index.js";

describe("workstream discord channel bindings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches workstreams by either routed channel id or stored thread id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    initDatabase(dbPath);

    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("portfolio-resume", "Portfolio & Resume", "C:/Users/wimer/Desktop/portfolio", "{}");

    const created = workstreams.create({
      project_id: "portfolio-resume",
      name: "Updating Portfolio",
      discord_channel_id: "parent-channel",
      discord_thread_id: "thread-channel",
    });

    expect(created.discord_channel_id).toBe("parent-channel");
    expect(created.discord_thread_id).toBe("thread-channel");

    expect(workstreams.listByDiscordChannel("parent-channel").map((row) => row.id)).toContain(created.id);
    expect(workstreams.listByDiscordChannel("thread-channel").map((row) => row.id)).toContain(created.id);
  });

  it("persists durable discord thread bindings with assistant ownership", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    initDatabase(dbPath);

    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("work", "Work", "C:/Users/wimer/Desktop/Work", "{}");

    const binding = discordThreadBindings.upsert({
      thread_id: "thread-123",
      parent_channel_id: "forum-456",
      project_id: "work",
      lane: "job-ops",
      base_branch: "main",
      assistant_enabled: true,
      owner_instance_id: "windows",
      source: "thread-title",
    });

    expect(binding.thread_id).toBe("thread-123");
    expect(binding.parent_channel_id).toBe("forum-456");
    expect(binding.project_id).toBe("work");
    expect(binding.lane).toBe("job-ops");
    expect(binding.base_branch).toBe("main");
    expect(binding.assistant_enabled).toBe(1);
    expect(binding.owner_instance_id).toBe("windows");
    expect(discordThreadBindings.getByThreadId("thread-123")?.source).toBe("thread-title");
  });

  it("stores host-local runtime bindings without overwriting durable workstream identity", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    initDatabase(dbPath);

    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("maverick", "Maverick", "C:/Users/wimer/Desktop/Maverick", "{}");

    const created = workstreams.create({
      project_id: "maverick",
      name: "shared state",
      cwd: "/srv/maverick/app",
      branch: "maverick/maverick/shared-state-1234567",
    });
    workstreams.update(created.id, { codex_thread_id: "linux-thread" });

    const linux = workstreamRuntimeBindings.upsert({
      workstream_id: created.id,
      instance_id: "linux",
      cwd: "/srv/maverick/app/.generated/worktrees/maverick/shared-state",
      codex_thread_id: "linux-thread",
    });
    const windows = workstreamRuntimeBindings.upsert({
      workstream_id: created.id,
      instance_id: "windows",
      cwd: "C:/Users/wimer/Desktop/Maverick/.generated/worktrees/maverick/shared-state",
      codex_thread_id: "windows-thread",
    });

    expect(linux.codex_thread_id).toBe("linux-thread");
    expect(windows.codex_thread_id).toBe("windows-thread");
    expect(workstreams.getById(created.id)?.codex_thread_id).toBe("linux-thread");
    expect(workstreamRuntimeBindings.listByWorkstream(created.id).map((binding) => binding.instance_id).sort()).toEqual([
      "linux",
      "windows",
    ]);
  });

  it("guards active workstream operations across owners", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    initDatabase(dbPath);

    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("maverick", "Maverick", "C:/Users/wimer/Desktop/Maverick", "{}");
    const created = workstreams.create({
      project_id: "maverick",
      name: "guarded work",
    });

    activeWorkstreamOperations.begin({
      workstream_id: created.id,
      operation_kind: "dispatch",
      owner_instance_id: "linux",
    });

    expect(() =>
      activeWorkstreamOperations.begin({
        workstream_id: created.id,
        operation_kind: "dispatch",
        owner_instance_id: "windows",
      })
    ).toThrow(/already running dispatch on linux/);

    activeWorkstreamOperations.complete(created.id, "linux");
    expect(
      activeWorkstreamOperations.begin({
        workstream_id: created.id,
        operation_kind: "dispatch",
        owner_instance_id: "windows",
      }).owner_instance_id
    ).toBe("windows");
  });

  it("allows only one running turn per workstream", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "maverick-state-"));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, "orchestrator.db");
    initDatabase(dbPath);

    const db = getDatabase();
    db.prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("maverick", "Maverick", "C:/Users/wimer/Desktop/Maverick", "{}");
    const created = workstreams.create({
      project_id: "maverick",
      name: "single running turn",
    });

    const first = turns.create({ workstream_id: created.id, instruction: "first" });
    const second = turns.create({ workstream_id: created.id, instruction: "second" });

    turns.update(first.id, { status: "running" });
    expect(() => turns.update(second.id, { status: "running" })).toThrow(/UNIQUE|constraint/i);
  });
});
