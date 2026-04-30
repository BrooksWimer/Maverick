import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestratorConfig } from "../../src/config/index.js";
import { DEFAULT_WORKFLOW } from "../../src/config/index.js";
import { BriefCollector } from "../../src/claude/brief-collector.js";
import {
  approvals,
  assistantCalendarEvents,
  assistantNotes,
  assistantReminders,
  closeDatabase,
  initDatabase,
  projects,
  turns,
  workstreams,
} from "../../src/state/index.js";

const config: OrchestratorConfig = {
  version: 1,
  defaults: {
    workflow: DEFAULT_WORKFLOW,
    executionBackend: {
      type: "mock",
      responseDelay: 1,
    },
    escalationRules: [],
    maxConcurrentWorkstreams: 6,
  },
  projects: [
    {
      id: "maverick",
      name: "Maverick",
      repoPath: "C:\\repo\\maverick",
      maxConcurrentWorkstreams: 3,
    },
  ],
  discord: {
    enabled: false,
    routes: [],
    defaultNotificationChannelId: null,
  },
  http: {
    enabled: false,
    port: 3847,
    host: "127.0.0.1",
  },
  assistant: {
    enabled: true,
    agentProjectId: "maverick",
    timeZone: "America/New_York",
    allowedPhoneNumbers: [],
    discord: {
      enabled: true,
      channelIds: [],
      allowedUserIds: [],
      replyInThread: false,
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
  brief: {
    enabled: true,
    schedule: "0 8 * * *",
    discordChannelId: null,
    storagePath: "./data/briefs",
    model: "sonnet",
  },
};

describe("BriefCollector", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-brief-"));
    initDatabase(join(tempDir, "brief.db"));

    projects.upsert({
      id: "maverick",
      name: "Maverick",
      repo_path: "C:\\repo\\maverick",
      config_json: JSON.stringify(config.projects[0]),
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("collects project and assistant context for the brief prompt", async () => {
    const workstream = workstreams.create({
      project_id: "maverick",
      name: "Claude rollout",
    });
    workstreams.update(workstream.id, {
      summary: "Phase 1 implementation in progress",
      current_goal: "Ship nightly brief",
      waiting_on_approval: 1,
    });

    const turn = turns.create({
      workstream_id: workstream.id,
      instruction: "Implement Phase 1",
    });
    turns.update(turn.id, {
      status: "completed",
      result_summary: "Claude brief path added",
      completed_at: "2026-04-08T11:00:00.000Z",
    });

    approvals.create({
      workstream_id: workstream.id,
      type: "command",
      description: "Need approval for something risky",
      tier: "approval-gated",
    });

    assistantNotes.create({
      title: "Project note",
      content: "Tagged note",
      tags_json: JSON.stringify(["maverick"]),
    });
    assistantNotes.create({
      title: "General note",
      content: "Untagged note",
      tags_json: JSON.stringify([]),
    });

    assistantReminders.create({
      body: "Check deployment",
      remind_at: "2026-04-09T13:00:00.000Z",
      channel: "discord",
      destination: "channel-1",
    });

    assistantCalendarEvents.create({
      title: "Demo",
      starts_at: "2026-04-09T14:00:00.000Z",
      ends_at: "2026-04-09T14:30:00.000Z",
      timezone: "America/New_York",
    });

    const collector = new BriefCollector(config, {
      now: new Date("2026-04-08T12:00:00.000Z"),
      gitRunner: async (args) => {
        if (args[0] === "status") {
          return "## main...origin/main [ahead 1]\n M src/orchestrator/orchestrator.ts";
        }
        return "abc123 add brief";
      },
    });

    const context = await collector.collect();

    expect(context.projects).toHaveLength(1);
    expect(context.projects[0].git.branch).toBe("main");
    expect(context.projects[0].git.ahead).toBe(1);
    expect(context.projects[0].workstreams[0].latestTurn?.summary).toBe("Claude brief path added");
    expect(context.projects[0].pendingApprovals).toHaveLength(1);
    expect(context.projects[0].taggedNotes).toHaveLength(1);
    expect(context.assistant.generalNotes).toHaveLength(1);
    expect(context.assistant.upcomingReminders).toHaveLength(1);
    expect(context.assistant.upcomingCalendarEvents).toHaveLength(1);
  });
});
