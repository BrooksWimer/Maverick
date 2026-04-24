import { createLogger } from "../../logger.js";
import type { AssistantConfig } from "../../config/index.js";
import type { CalendarCreateResult, CalendarEventInput, CalendarProvider } from "../types.js";
import { refreshGoogleAccessToken } from "./google-auth.js";

const log = createLogger("assistant:calendar");

class MemoryCalendarProvider implements CalendarProvider {
  readonly name = "memory";

  async createEvent(): Promise<CalendarCreateResult> {
    return {
      provider: this.name,
      status: "pending-config",
      error: "Calendar provider is not configured; event was stored locally only.",
    };
  }
}

class DisabledCalendarProvider implements CalendarProvider {
  readonly name = "disabled";

  async createEvent(): Promise<CalendarCreateResult> {
    return {
      provider: this.name,
      status: "pending-config",
      error: "Calendar integration is disabled.",
    };
  }
}

class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";

  constructor(private readonly assistantConfig: AssistantConfig) {}

  async createEvent(input: CalendarEventInput): Promise<CalendarCreateResult> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      return {
        provider: this.name,
        status: "pending-config",
        error: "Missing Google Calendar OAuth credentials.",
      };
    }

    try {
      const accessToken = await refreshGoogleAccessToken(clientId, clientSecret, refreshToken);
      const calendarId = encodeURIComponent(this.assistantConfig.calendar.calendarId);
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildGoogleCalendarPayload(input)),
      });

      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const errorMessage =
          typeof payload.error === "object" && payload.error && "message" in payload.error
            ? String((payload.error as { message?: unknown }).message ?? "Unknown Google Calendar error")
            : `Google Calendar request failed with status ${response.status}`;
        return {
          provider: this.name,
          status: "failed",
          error: errorMessage,
        };
      }

      return {
        provider: this.name,
        status: "synced",
        providerEventId: typeof payload.id === "string" ? payload.id : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ err: error }, "Google Calendar event creation failed");
      return {
        provider: this.name,
        status: "failed",
        error: message,
      };
    }
  }
}

function buildGoogleCalendarPayload(input: CalendarEventInput): Record<string, unknown> {
  if (input.isAllDay) {
    const startDate = new Date(input.startsAt);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);

    return {
      summary: input.title,
      description: input.description ?? undefined,
      location: input.location ?? undefined,
      start: {
        date: startDate.toISOString().slice(0, 10),
        timeZone: input.timeZone,
      },
      end: {
        date: endDate.toISOString().slice(0, 10),
        timeZone: input.timeZone,
      },
    };
  }

  return {
    summary: input.title,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: {
      dateTime: input.startsAt,
      timeZone: input.timeZone,
    },
    end: {
      dateTime: input.endsAt ?? input.startsAt,
      timeZone: input.timeZone,
    },
  };
}

export function createCalendarProvider(config: AssistantConfig): CalendarProvider {
  switch (config.calendar.provider) {
    case "google":
      return new GoogleCalendarProvider(config);
    case "disabled":
      return new DisabledCalendarProvider();
    case "memory":
    default:
      return new MemoryCalendarProvider();
  }
}
