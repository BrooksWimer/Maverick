import { describe, expect, it } from "vitest";
import { parseAssistantIntent } from "../../src/assistant/parser.js";

describe("parseAssistantIntent", () => {
  it("captures actionable chat as an inbox task", () => {
    const intent = parseAssistantIntent("Pick up dry cleaning and ask about tailoring");

    expect(intent.kind).toBe("task");
    if (intent.kind !== "task") {
      return;
    }

    expect(intent.status).toBe("inbox");
    expect(intent.primaryContext).toBe("errands");
    expect(intent.details).toContain("dry cleaning");
  });

  it("keeps pure reference info as a note", () => {
    const intent = parseAssistantIntent("Remember that the contractor prefers text messages before 9am.");

    expect(intent.kind).toBe("note");
    if (intent.kind !== "note") {
      return;
    }

    expect(intent.context).toBe("home");
    expect(intent.content).toContain("contractor");
  });

  it("parses agenda-style queries", () => {
    const intent = parseAssistantIntent("What do I need to do today?");

    expect(intent.kind).toBe("query");
    if (intent.kind !== "query") {
      return;
    }

    expect(intent.queryType).toBe("agenda");
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
    expect(intent.primaryContext).toBe("health");
    expect(intent.startsAt).toBe("2026-04-07T18:30:00.000Z");
    expect(intent.endsAt).toBe("2026-04-07T19:15:00.000Z");
  });

  it("parses recurring weekday calendar items", () => {
    const intent = parseAssistantIntent("calendar take vitamins every weekday at 5:30pm", {
      referenceDate: new Date("2026-04-24T20:00:00-04:00"),
      defaultEventDurationMinutes: 30,
    });

    expect(intent.kind).toBe("calendar");
    if (intent.kind !== "calendar") {
      return;
    }

    expect(intent.title).toBe("take vitamins");
    expect(intent.startsAt).toBe("2026-04-27T21:30:00.000Z");
    expect(intent.endsAt).toBe("2026-04-27T22:00:00.000Z");
    expect(intent.recurrenceRule).toBe("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
  });

  it("classifies work study notes toward the engineering learning smart goal", () => {
    const intent = parseAssistantIntent("Study note: read a distributed systems article and write takeaways", {
      workSmartGoals: [
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
    });

    expect(intent.kind).toBe("note");
    if (intent.kind !== "note") {
      return;
    }

    expect(intent.context).toBe("work");
    expect(intent.noteKind).toBe("study");
    expect(intent.smartGoalIds).toContain("engineering-learning");
  });

  it("treats attachment-only captures as notes instead of clarification", () => {
    const intent = parseAssistantIntent("", {
      attachments: [
        {
          name: "acceptance-criteria.png",
          contentType: "image/png",
          url: "https://example.test/acceptance-criteria.png",
        },
      ],
      workSmartGoals: [
        {
          id: "business-context",
          title: "Business Context Deep Dives",
          description: "Business learning",
        },
      ],
    });

    expect(intent.kind).toBe("note");
    if (intent.kind !== "note") {
      return;
    }

    expect(intent.context).toBe("work");
    expect(intent.noteKind).toBe("acceptance-criteria");
  });
});
