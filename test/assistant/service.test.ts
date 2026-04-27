import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantConfig } from "../../src/config/index.js";
import { AssistantService } from "../../src/assistant/service.js";
import { closeDatabase, getDatabase, initDatabase } from "../../src/state/index.js";
import type { WorkNotesConfig } from "../../src/assistant/types.js";

const baseConfig: AssistantConfig = {
  enabled: true,
  agentProjectId: "maverick",
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
  modelRouting: {
    profiles: {
      cheap: "gpt-5.4-mini",
      default: "gpt-5.4",
      deep: "gpt-5.2",
    },
    defaults: {
      classification: "cheap",
      query: "cheap",
      summary: "default",
      planning: "deep",
      verification: "deep",
      review: "deep",
    },
    allowMessagePrefixes: true,
  },
  drive: {
    enabled: false,
    provider: "disabled",
    exportPath: "./data/life-os-drive",
    googleRootFolderId: null,
    syncOnChange: true,
  },
};

describe("AssistantService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-assistant-"));
    initDatabase(join(tempDir, "assistant.db"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores pure reference messages as notes", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "Remember that the contractor prefers text messages before 9am.",
    });

    expect(result.intent).toBe("note");
    expect(service.listNotes()).toHaveLength(1);
    expect(service.listMessages()).toHaveLength(2);
  });

  it("tags inbound discord assistant messages with project, lane, and thread context", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });
    getDatabase().prepare(`
      INSERT INTO projects (id, name, repo_path, config_json)
      VALUES (?, ?, ?, ?)
    `).run("portfolio-resume", "Portfolio & Resume", "C:/Users/wimer/Desktop/portfolio", "{}");

    await service.processIncomingMessage({
      source: "discord",
      from: "user-123",
      body: "Remember the portfolio lane needs a forum-thread assistant.",
      metadata: {
        channelId: "thread-123",
        projectId: "portfolio-resume",
        laneId: "portfolio-resume",
        threadId: "thread-123",
      },
    });

    const inbound = service.listMessages().find((message) => message.direction === "inbound");
    expect(inbound?.project_id).toBe("portfolio-resume");
    expect(inbound?.lane_id).toBe("portfolio-resume");
    expect(inbound?.thread_id).toBe("thread-123");
  });

  it("turns actionable chat into inbox tasks", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "Pick up dry cleaning and ask about tailoring",
    });

    expect(result.intent).toBe("task");
    const tasks = service.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("inbox");
    expect(tasks[0].primary_context).toBe("errands");
  });

  it("creates linked tasks for reminders", async () => {
    const service = new AssistantService(
      {
        ...baseConfig,
        reminders: {
          ...baseConfig.reminders,
          defaultChannel: "sms",
        },
      },
      {
        now: () => new Date("2026-04-04T10:00:00-04:00"),
      }
    );

    const result = await service.processIncomingMessage({
      source: "sms",
      from: "+15551234567",
      body: "remind me to take the trash out tomorrow at 8pm",
    });

    expect(result.intent).toBe("reminder");
    expect(service.listReminders()).toHaveLength(1);
    expect(service.listTasks()).toHaveLength(1);
    expect(service.listTasks()[0].status).toBe("scheduled");
    expect(service.listTasks()[0].reminder_id).toBe(service.listReminders()[0].id);
  });

  it("schedules reminders back into the originating Discord channel", async () => {
    const delivered: Array<{ destination: string; body: string }> = [];
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    service.setReminderDispatcher(async ({ destination, body }) => {
      delivered.push({ destination, body });
      return {
        provider: "discord",
        status: "sent",
      };
    });

    await service.processIncomingMessage({
      source: "discord",
      from: "user-1",
      replyTarget: "channel-1",
      body: "remind me to submit rent Monday at 9am",
    });

    await service.processDueReminders(new Date("2026-04-06T13:05:00.000Z"));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].destination).toBe("channel-1");
    expect(delivered[0].body).toContain("submit rent");
  });

  it("syncs calendar events through the configured provider and can create linked tasks", async () => {
    const createEvent = vi.fn(async () => ({
      provider: "mock-calendar",
      status: "synced" as const,
      providerEventId: "evt_123",
    }));
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
      calendarProvider: {
        name: "mock-calendar",
        createEvent,
      },
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "calendar submit quarterly taxes 2026-04-10 11:00am",
    });

    expect(result.intent).toBe("calendar");
    const events = service.listCalendarEvents();
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe("mock-calendar");
    expect(events[0].provider_event_id).toBe("evt_123");
    expect(events[0].sync_status).toBe("synced");
    expect(service.listTasks()).toHaveLength(1);
    expect(service.listTasks()[0].calendar_event_id).toBe(events[0].id);
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: "submit quarterly taxes",
      recurrenceRule: null,
    }));
  });

  it("syncs recurring calendar events and keeps the next occurrence in agenda", async () => {
    const createEvent = vi.fn(async () => ({
      provider: "mock-calendar",
      status: "synced" as const,
      providerEventId: "evt_recurring",
    }));
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-24T20:00:00-04:00"),
      calendarProvider: {
        name: "mock-calendar",
        createEvent,
      },
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "calendar take vitamins every weekday at 5:30pm",
    });

    expect(result.intent).toBe("calendar");
    const events = service.listCalendarEvents();
    expect(events).toHaveLength(1);
    expect(events[0].recurrence_rule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      recurrenceRule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    }));

    const agenda = service.getAgenda(undefined, new Date("2026-04-28T00:00:00.000Z"));
    expect(agenda.upcomingCalendar).toHaveLength(1);
    expect(agenda.upcomingCalendar[0].title).toBe("take vitamins");
    expect(agenda.upcomingCalendar[0].recurrenceRule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(agenda.upcomingCalendar[0].startsAt).toBe("2026-04-28T21:30:00.000Z");
  });

  it("returns markdown attachments for agenda queries", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    await service.processIncomingMessage({
      source: "api",
      body: "Pick up dry cleaning and ask about tailoring",
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "What do I need to do today?",
    });

    expect(result.intent).toBe("query");
    expect(result.attachment?.name).toBe("assistant-agenda.md");
    expect(result.attachment?.content).toContain("# Assistant Agenda");
  });

  it("supports channel-scoped model overrides", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    service.setModelOverride({
      scope: "discord-channel",
      scopeId: "channel-1",
      feature: "classification",
      profile: "deep",
    });

    const state = service.getModelState({
      source: "discord",
      channelId: "channel-1",
    });

    expect(state.effective.classification).toBe("deep");
    expect(state.overrides).toHaveLength(1);
  });

  it("uses the interpreter for natural language reminder reasoning", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T23:44:00.000Z"),
      interpreter: {
        async interpret() {
          return {
            kind: "reminder",
            body: "fart",
            remindAt: "2026-04-04T23:59:00.000Z",
            parsedFrom: "agent",
            confidence: 0.94,
          };
        },
      },
    });

    const result = await service.processIncomingMessage({
      source: "discord",
      from: "user-1",
      replyTarget: "channel-1",
      body: "[deep] set a reminder for me 15 minutes from now to fart",
    });

    expect(result.intent).toBe("reminder");
    const reminders = service.listReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].body).toBe("fart");
    expect(reminders[0].remind_at).toBe("2026-04-04T23:59:00.000Z");
  });

  it("stores work notes with attachments in the Work workspace", async () => {
    const workRepo = join(tempDir, "Work");
    const workNotes: WorkNotesConfig = {
      projectId: "work",
      repoPath: workRepo,
      smartGoals: [
        {
          id: "business-context",
          title: "Business Context Deep Dives",
          description: "Business learning",
        },
        {
          id: "engineering-learning",
          title: "Independent Engineering Learning",
          description: "Engineering learning",
        },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      }))
    );

    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-05T09:15:00.000Z"),
      workNotes,
      interpreter: {
        async interpret() {
          return {
            kind: "note",
            title: "Checkout acceptance criteria",
            content: "Captured acceptance criteria for the checkout ticket.",
            confidence: 0.91,
            context: "work",
            noteKind: "acceptance-criteria",
            projectName: "Checkout Revamp",
            smartGoalIds: ["business-context"],
          };
        },
      },
    });

    const result = await service.processIncomingMessage({
      source: "discord",
      from: "user-1",
      replyTarget: "channel-1",
      body: "Acceptance criteria screenshot from today's ticket",
      attachments: [
        {
          name: "criteria.png",
          contentType: "image/png",
          url: "https://example.test/criteria.png",
        },
      ],
    });

    expect(result.intent).toBe("note");
    const notes = service.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].note_context).toBe("work");
    expect(notes[0].note_kind).toBe("acceptance-criteria");
    expect(notes[0].project_name).toBe("Checkout Revamp");
    expect(notes[0].storage_path).toContain(join("Work", "projects", "checkout-revamp"));
    expect(notes[0].attachments_json).toContain("criteria.png");

    expect(notes[0].storage_path).not.toBeNull();
    expect(existsSync(notes[0].storage_path!)).toBe(true);
    const noteFile = readFileSync(notes[0].storage_path!, "utf8");
    expect(noteFile).toContain("Checkout acceptance criteria");
    expect(noteFile).toContain("Business Context Deep Dives");

    const activityPath = join(workRepo, "smart-goals", "business-context", "activity.md");
    expect(readFileSync(activityPath, "utf8")).toContain("Checkout acceptance criteria");
  });

  it("supports structured work-note capture without parser inference", async () => {
    const workRepo = join(tempDir, "Work");
    const workNotes: WorkNotesConfig = {
      projectId: "work",
      repoPath: workRepo,
      smartGoals: [
        {
          id: "business-context",
          title: "Business Context Deep Dives",
          description: "Business learning",
        },
        {
          id: "engineering-learning",
          title: "Independent Engineering Learning",
          description: "Engineering learning",
        },
      ],
    };

    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-05T11:30:00.000Z"),
      workNotes,
    });

    const result = await service.processIncomingMessage({
      source: "discord",
      from: "user-1",
      replyTarget: "channel-1",
      body: "",
      structuredNote: {
        title: "DDD study session",
        content: "Read about domain-driven design aggregates and noted tradeoffs.",
        context: "work",
        noteKind: "study",
        projectName: "design-patterns-gof",
        smartGoalIds: ["engineering-learning"],
      },
    });

    expect(result.intent).toBe("note");
    const notes = service.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].note_context).toBe("work");
    expect(notes[0].note_kind).toBe("study");
    expect(notes[0].project_name).toBe("design-patterns-gof");
    expect(notes[0].smart_goal_ids_json).toContain("engineering-learning");
    expect(notes[0].storage_path).toContain(join("Work", "study", "projects", "design-patterns-gof"));
  });
});
