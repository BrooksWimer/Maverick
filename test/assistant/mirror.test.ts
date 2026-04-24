import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantDriveMirrorService } from "../../src/assistant/mirror.js";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import {
  artifacts,
  assistantNotes,
  assistantTasks,
  closeDatabase,
  initDatabase,
  projects,
  workstreams,
} from "../../src/state/index.js";

describe("AssistantDriveMirrorService", () => {
  let tempDir: string;
  let repoPath: string;
  let exportPath: string;
  let config: OrchestratorConfig;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-mirror-"));
    repoPath = join(tempDir, "repo");
    exportPath = join(tempDir, "drive-export");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Agents", "utf8");
    writeFileSync(join(repoPath, "README.md"), "# Repo", "utf8");
    writeFileSync(join(repoPath, "docs", "ARCHITECTURE.md"), "# Architecture", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");
    writeFileSync(join(repoPath, "changed.ts"), "export const value = 1;\n", "utf8");

    initDatabase(join(tempDir, "orchestrator.db"));
    config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: {
          type: "mock",
          responseDelay: 0,
        },
      },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
      assistant: {
        enabled: true,
        agentProjectId: "maverick",
        timeZone: "America/New_York",
        drive: {
          enabled: true,
          provider: "local",
          exportPath,
          googleRootFolderId: null,
          syncOnChange: true,
        },
      },
    });

    projects.upsert({
      id: "maverick",
      name: "Maverick",
      repo_path: repoPath,
      config_json: JSON.stringify(config.projects[0]),
    });

    const workstream = workstreams.create({
      project_id: "maverick",
      name: "mirror task",
      cwd: repoPath,
    });

    assistantTasks.create({
      title: "Pick up dry cleaning",
      details: "Ask about tailoring too.",
      primary_context: "errands",
      status: "inbox",
    });
    assistantNotes.create({
      title: "Contractor note",
      content: "Prefers text messages before 9am.",
      note_context: "home",
    });
    artifacts.create({
      workstream_id: workstream.id,
      type: "operator-report",
      name: "dispatch-operator-report",
      metadata_json: JSON.stringify({
        headline: "Dispatch completed",
        summary: "Updated the life OS task handling.",
        filesChanged: ["changed.ts"],
      }),
      content: "Implemented the task pipeline.",
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes curated and raw local mirror exports", async () => {
    const mirror = new AssistantDriveMirrorService(config, {
      now: () => new Date("2026-04-24T14:00:00.000Z"),
    });

    await mirror.syncAll();

    expect(existsSync(join(exportPath, "Life OS", "Agenda.md"))).toBe(true);
    expect(existsSync(join(exportPath, "Life OS", "Inbox.md"))).toBe(true);
    expect(existsSync(join(exportPath, "Projects", "Index.md"))).toBe(true);
    expect(existsSync(join(exportPath, "Projects", "maverick", "Summary.md"))).toBe(true);
    expect(existsSync(join(exportPath, "raw", "tasks"))).toBe(true);
    expect(existsSync(join(exportPath, "raw", "notes"))).toBe(true);
    expect(existsSync(join(exportPath, "Projects", "maverick", "repo-docs", "AGENTS.md"))).toBe(true);
    const selectedArtifactsRoot = join(exportPath, "Projects", "maverick", "selected-artifacts");
    const selectedArtifactDirs = readdirSync(selectedArtifactsRoot);
    expect(selectedArtifactDirs.length).toBeGreaterThan(0);
    expect(existsSync(join(selectedArtifactsRoot, selectedArtifactDirs[0], "changed.ts"))).toBe(true);

    expect(readFileSync(join(exportPath, "Life OS", "Agenda.md"), "utf8")).toContain("# Assistant Agenda");
    expect(readFileSync(join(exportPath, "Life OS", "Inbox.md"), "utf8")).toContain("Pick up dry cleaning");
  });
});
