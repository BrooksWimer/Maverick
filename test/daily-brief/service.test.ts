import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DailyBriefService } from "../../src/daily-brief/index.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import {
  assistantNotes,
  assistantReminders,
  closeDatabase,
  getDatabase,
  initDatabase,
  turns,
  workstreams,
} from "../../src/state/index.js";

describe("DailyBriefService", () => {
  let tempDir: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-daily-brief-"));
    initDatabase(join(tempDir, "orchestrator.db"));

    const alphaRepo = join(tempDir, "Alpha");
    const betaRepo = join(tempDir, "Beta");
    mkdirSync(alphaRepo, { recursive: true });
    mkdirSync(betaRepo, { recursive: true });

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
          id: "alpha",
          name: "Alpha",
          repoPath: alphaRepo,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
        {
          id: "beta",
          name: "Beta",
          repoPath: betaRepo,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
      discord: {
        enabled: false,
        routes: [],
      },
      assistant: {
        enabled: true,
        agentProjectId: "alpha",
        timeZone: "America/New_York",
        allowedPhoneNumbers: [],
        discord: {
          enabled: true,
          channelIds: ["channel-1"],
          allowedUserIds: [],
          replyInThread: true,
        },
        sms: {
          provider: "disabled",
          replyToInbound: true,
          fromNumber: null,
          requireSignatureValidation: false,
        },
        calendar: {
          provider: "memory",
          calendarId: "primary",
          defaultEventDurationMinutes: 30,
        },
        reminders: {
          enabled: true,
          pollIntervalMs: 60_000,
          defaultChannel: "discord",
          requireTimeForReminders: false,
        },
      },
      dailyBrief: {
        enabled: true,
        timeZone: "America/New_York",
        deliveryHour: 21,
        deliveryMinute: 0,
        pollIntervalMs: 300_000,
        artifactDirectory: join(tempDir, "briefs"),
        maxProjectsInDigest: 10,
        maxNotesInDigest: 8,
        maxRemindersInDigest: 5,
      },
    });

    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
  });

  afterEach(async () => {
    await orchestrator.shutdown();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("collects project activity, fallbacks, hygiene, notes, and reminders into one report", async () => {
    const referenceTime = new Date("2026-04-06T23:15:00.000Z");
    const db = getDatabase();

    const alpha = workstreams.create({
      project_id: "alpha",
      name: "Build onboarding flow",
      cwd: join(tempDir, "Alpha"),
      branch: "maverick/alpha/onboarding",
    });
    workstreams.update(alpha.id, {
      state: "implementation",
      current_goal: "Finish the onboarding confirmation UI and wire it to the new backend endpoint.",
      summary: "Built most of the onboarding UI.",
    });
    db.prepare("UPDATE workstreams SET last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-04-06T18:45:00.000Z", "2026-04-06T18:45:00.000Z", alpha.id);

    const alphaTurn = turns.create({
      workstream_id: alpha.id,
      instruction: "Finish onboarding confirmation flow",
    });
    turns.update(alphaTurn.id, {
      status: "completed",
      result_summary: "Finished the confirmation screen and hooked up optimistic state updates.",
      started_at: "2026-04-06T18:10:00.000Z",
      completed_at: "2026-04-06T18:40:00.000Z",
    });
    db.prepare("UPDATE turns SET created_at = ? WHERE id = ?")
      .run("2026-04-06T18:10:00.000Z", alphaTurn.id);

    const beta = workstreams.create({
      project_id: "beta",
      name: "Stabilize importer",
      cwd: join(tempDir, "Beta"),
      branch: "maverick/beta/importer",
    });
    workstreams.update(beta.id, {
      state: "planning",
      summary: "Importer retries were investigated and a follow-up batch design is still needed.",
    });
    db.prepare("UPDATE workstreams SET last_activity_at = ?, updated_at = ? WHERE id = ?")
      .run("2026-04-05T15:00:00.000Z", "2026-04-05T15:00:00.000Z", beta.id);

    assistantNotes.create({
      title: "Alpha acceptance notes",
      content: "Customer wants the onboarding success state to mention email verification.",
      note_context: "work",
      note_kind: "acceptance-criteria",
      project_name: "Alpha",
    });
    db.prepare("UPDATE assistant_notes SET created_at = ? WHERE title = ?")
      .run("2026-04-06T19:05:00.000Z", "Alpha acceptance notes");

    assistantReminders.create({
      body: "Check with design on Beta importer edge cases",
      remind_at: "2026-04-07T13:00:00.000Z",
      channel: "discord",
      destination: "channel-1",
      provider: "discord",
      status: "scheduled",
    });

    const service = new DailyBriefService(orchestrator, config, {
      now: () => referenceTime,
      inspectWorkspace: async (cwd) => ({
        cwd,
        isGitRepository: true,
        branch: cwd.endsWith("Alpha") ? "maverick/alpha/onboarding" : "maverick/beta/importer",
        clean: cwd.endsWith("Beta"),
        stagedCount: 0,
        unstagedCount: cwd.endsWith("Alpha") ? 2 : 0,
        untrackedCount: cwd.endsWith("Alpha") ? 1 : 0,
        aheadCount: 0,
        behindCount: 0,
        latestCommit: {
          hash: "abc123",
          committedAt: "2026-04-05T15:00:00.000Z",
          subject: cwd.endsWith("Alpha") ? "Polish onboarding layout" : "Investigate importer retries",
        },
        error: null,
      }),
    });

    const report = await service.generateReport(referenceTime);

    expect(report.preview).toContain("Projects with activity today: 1/2");
    expect(report.preview).toContain("Alpha: worked today");
    expect(report.preview).toContain("Beta: no update today");

    expect(report.markdown).toContain("## Alpha");
    expect(report.markdown).toContain("Worked on today");
    expect(report.markdown).toContain("Finished the confirmation screen and hooked up optimistic state updates.");
    expect(report.markdown).toContain("Continue Build onboarding flow");
    expect(report.markdown).toContain("Alpha acceptance notes");
    expect(report.markdown).toContain("Build onboarding flow on `maverick/alpha/onboarding` is dirty");

    expect(report.markdown).toContain("## Beta");
    expect(report.markdown).toContain("No new activity today. Latest update");
    expect(report.markdown).toContain("Importer retries were investigated");
    expect(report.markdown).toContain("Check with design on Beta importer edge cases");

    expect(existsSync(report.artifactPath)).toBe(true);
    expect(readFileSync(report.artifactPath, "utf8")).toContain("# Maverick Daily Brief - 2026-04-06");
  });
});
