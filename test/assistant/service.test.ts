import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantConfig } from "../../src/config/index.js";
import { AssistantService } from "../../src/assistant/service.js";
import { closeDatabase, initDatabase } from "../../src/state/index.js";

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
};

describe("AssistantService", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-assistant-"));
    initDatabase(join(tempDir, "assistant.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores freeform messages as notes", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "Remember to check on the contractor quote",
    });

    expect(result.intent).toBe("note");
    expect(service.listNotes()).toHaveLength(1);
    expect(service.listMessages()).toHaveLength(2);
  });

  it("schedules reminders from inbound texts", async () => {
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
    const reminders = service.listReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].destination).toBe("+15551234567");
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

    const reminders = service.listReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].destination).toBe("channel-1");

    await service.processDueReminders(new Date("2026-04-06T13:05:00.000Z"));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].destination).toBe("channel-1");
    expect(delivered[0].body).toContain("submit rent");
  });

  it("syncs calendar events through the configured provider", async () => {
    const service = new AssistantService(baseConfig, {
      now: () => new Date("2026-04-04T10:00:00-04:00"),
      calendarProvider: {
        name: "mock-calendar",
        async createEvent() {
          return {
            provider: "mock-calendar",
            status: "synced",
            providerEventId: "evt_123",
          };
        },
      },
    });

    const result = await service.processIncomingMessage({
      source: "api",
      body: "calendar tax appointment 2026-04-10 11:00am",
    });

    expect(result.intent).toBe("calendar");
    const events = service.listCalendarEvents();
    expect(events).toHaveLength(1);
    expect(events[0].provider).toBe("mock-calendar");
    expect(events[0].provider_event_id).toBe("evt_123");
    expect(events[0].sync_status).toBe("synced");
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
      body: "set a reminder for me 15 minutes from now to fart",
    });

    expect(result.intent).toBe("reminder");
    const reminders = service.listReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].body).toBe("fart");
    expect(reminders[0].remind_at).toBe("2026-04-04T23:59:00.000Z");
  });
});
