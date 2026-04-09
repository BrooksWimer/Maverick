import { describe, expect, it } from "vitest";
import { cronMatchesDate, scheduledMinuteKey } from "../../src/claude/schedule.js";

describe("cronMatchesDate", () => {
  it("matches a daily schedule in the configured timezone", () => {
    const date = new Date("2026-04-08T12:00:00.000Z");
    expect(cronMatchesDate("0 8 * * *", date, "America/New_York")).toBe(true);
  });

  it("matches stepped weekday schedules", () => {
    const date = new Date("2026-04-06T13:30:00.000Z");
    expect(cronMatchesDate("*/15 9 * * 1-5", date, "America/New_York")).toBe(true);
  });

  it("does not match outside the requested window", () => {
    const date = new Date("2026-04-05T13:30:00.000Z");
    expect(cronMatchesDate("*/15 9 * * 1-5", date, "America/New_York")).toBe(false);
  });

  it("creates stable dedupe keys per scheduled minute", () => {
    const date = new Date("2026-04-08T12:00:00.000Z");
    expect(scheduledMinuteKey(date, "America/New_York")).toBe("4-8 8:0");
  });
});
