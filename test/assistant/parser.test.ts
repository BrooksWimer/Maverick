import { describe, expect, it } from "vitest";
import { parseAssistantIntent } from "../../src/assistant/parser.js";

describe("parseAssistantIntent", () => {
  it("treats unmatched text as a note", () => {
    const intent = parseAssistantIntent("Pick up dry cleaning and ask about tailoring");

    expect(intent.kind).toBe("note");
    if (intent.kind !== "note") {
      return;
    }

    expect(intent.content).toContain("dry cleaning");
  });

  it("parses reminders with relative times", () => {
    const intent = parseAssistantIntent("remind me to call mom tomorrow at 6pm", {
      referenceDate: new Date("2026-04-04T10:00:00-04:00"),
    });

    expect(intent.kind).toBe("reminder");
    if (intent.kind !== "reminder") {
      return;
    }

    expect(intent.body).toBe("call mom");
    expect(intent.remindAt).toBe("2026-04-05T22:00:00.000Z");
  });

  it("parses 'set reminder' phrasing as a reminder", () => {
    const intent = parseAssistantIntent("set reminder to take vitamins tomorrow at 8am", {
      referenceDate: new Date("2026-04-04T10:00:00-04:00"),
    });

    expect(intent.kind).toBe("reminder");
    if (intent.kind !== "reminder") {
      return;
    }

    expect(intent.body).toBe("take vitamins");
    expect(intent.remindAt).toBe("2026-04-05T12:00:00.000Z");
  });

  it("parses calendar items with explicit dates", () => {
    const intent = parseAssistantIntent("calendar dentist appointment 2026-04-07 2:30pm", {
      referenceDate: new Date("2026-04-04T10:00:00-04:00"),
      defaultEventDurationMinutes: 45,
    });

    expect(intent.kind).toBe("calendar");
    if (intent.kind !== "calendar") {
      return;
    }

    expect(intent.title).toBe("dentist appointment");
    expect(intent.startsAt).toBe("2026-04-07T18:30:00.000Z");
    expect(intent.endsAt).toBe("2026-04-07T19:15:00.000Z");
  });
});
