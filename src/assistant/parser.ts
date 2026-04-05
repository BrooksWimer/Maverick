import type { ParsedAssistantIntent } from "./types.js";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

type ParseAssistantIntentOptions = {
  referenceDate?: Date;
  defaultEventDurationMinutes?: number;
  defaultReminderHour?: number;
  requireTimeForReminders?: boolean;
};

type ScheduleParseResult = {
  startsAt: string;
  endsAt: string | null;
  isAllDay: boolean;
  parsedFrom: string;
};

export function normalizeAssistantText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function parseAssistantIntent(
  text: string,
  options: ParseAssistantIntentOptions = {}
): ParsedAssistantIntent {
  const normalized = normalizeAssistantText(text);
  if (!normalized) {
    return {
      kind: "clarification",
      message: "Send a note, reminder, or calendar item with some text so I can store it.",
      confidence: 0.2,
    };
  }

  const reminder = parseReminderIntent(normalized, options);
  if (reminder) {
    return reminder;
  }

  const calendar = parseCalendarIntent(normalized, options);
  if (calendar) {
    return calendar;
  }

  return parseNoteIntent(normalized);
}

function parseReminderIntent(
  text: string,
  options: ParseAssistantIntentOptions
): ParsedAssistantIntent | null {
  const remainder = extractReminderRemainder(text);
  if (!remainder) {
    return null;
  }

  const split = splitDescriptionAndSchedule(remainder);
  if (!split.description) {
    return {
      kind: "clarification",
      message: "I can set that reminder, but I need to know what you want me to remind you about.",
      confidence: 0.5,
    };
  }

  if (!split.scheduleText) {
    return {
      kind: "clarification",
      message: "I can set that reminder, but I need a time like 'tomorrow at 9am' or '2026-04-05 18:00'.",
      confidence: 0.55,
    };
  }

  const scheduled = parseScheduleText(split.scheduleText, {
    referenceDate: options.referenceDate,
    defaultHour: options.defaultReminderHour ?? 9,
    defaultDurationMinutes: options.defaultEventDurationMinutes ?? 30,
    allowAllDay: !options.requireTimeForReminders,
  });

  if (!scheduled) {
    return {
      kind: "clarification",
      message: "I couldn't parse that reminder time. Try 'remind me to call mom tomorrow at 6pm'.",
      confidence: 0.4,
    };
  }

  return {
    kind: "reminder",
    body: cleanupReminderDescription(split.description),
    remindAt: scheduled.startsAt,
    parsedFrom: scheduled.parsedFrom,
    confidence: 0.86,
  };
}

function parseCalendarIntent(
  text: string,
  options: ParseAssistantIntentOptions
): ParsedAssistantIntent | null {
  const match = text.match(/^(?:calendar|schedule|add to calendar|add event|event)\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const remainder = match[1].trim();
  const split = splitDescriptionAndSchedule(remainder);
  if (!split.scheduleText) {
    return {
      kind: "clarification",
      message: "I can add that to your calendar, but I need a date like 'tomorrow at 3pm' or '2026-04-06'.",
      confidence: 0.52,
    };
  }

  const scheduled = parseScheduleText(split.scheduleText, {
    referenceDate: options.referenceDate,
    defaultHour: 9,
    defaultDurationMinutes: options.defaultEventDurationMinutes ?? 30,
    allowAllDay: true,
  });

  if (!scheduled) {
    return {
      kind: "clarification",
      message: "I couldn't parse that calendar time. Try 'calendar dentist appointment 2026-04-07 14:30'.",
      confidence: 0.4,
    };
  }

  const title = cleanupSentence(split.description);
  return {
    kind: "calendar",
    title,
    startsAt: scheduled.startsAt,
    endsAt: scheduled.endsAt,
    isAllDay: scheduled.isAllDay,
    parsedFrom: scheduled.parsedFrom,
    details: text,
    location: null,
    confidence: 0.83,
  };
}

function extractReminderRemainder(text: string): string | null {
  const patterns = [
    /^set\s+(?:me\s+)?(?:a\s+)?reminder\s+(?:to|for|about)\s+(.+)$/i,
    /^set\s+(?:me\s+)?(?:a\s+)?reminder\s+(.+)$/i,
    /^remind me\s+(?:to|about)\s+(.+)$/i,
    /^remind me\s+(.+)$/i,
    /^reminder\s+(?:to|for|about)\s+(.+)$/i,
    /^reminder\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return cleanupSentence(match[1]);
    }
  }

  return null;
}

function parseNoteIntent(text: string): ParsedAssistantIntent {
  const content = text.replace(/^(?:note|remember|memo)[:\s-]*/i, "").trim() || text;
  return {
    kind: "note",
    title: summarizeTitle(content),
    content,
    confidence: 0.75,
  };
}

function splitDescriptionAndSchedule(text: string): {
  description: string;
  scheduleText: string | null;
} {
  const patterns = [
    /\b(?:on\s+)?\d{4}-\d{2}-\d{2}\b/i,
    /\b(?:on\s+)?(?:today|tomorrow)\b/i,
    /\b(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  ];

  let earliest: RegExpMatchArray | null = null;
  let earliestIndex = Number.POSITIVE_INFINITY;

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined && match.index < earliestIndex) {
      earliest = match;
      earliestIndex = match.index;
    }
  }

  if (!earliest || earliest.index === undefined) {
    return {
      description: cleanupSentence(text),
      scheduleText: null,
    };
  }

  return {
    description: cleanupSentence(text.slice(0, earliest.index)),
    scheduleText: cleanupSentence(text.slice(earliest.index)),
  };
}

function parseScheduleText(
  raw: string,
  options: {
    referenceDate?: Date;
    defaultHour: number;
    defaultDurationMinutes: number;
    allowAllDay: boolean;
  }
): ScheduleParseResult | null {
  const reference = options.referenceDate ?? new Date();
  const duration = extractDurationMinutes(raw, options.defaultDurationMinutes);
  const text = cleanupSentence(duration.text);

  const relativeMatch = text.match(
    /^(?:on\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s+(?:at\s+)?)?(\d{1,2})?(?::(\d{2}))?\s*(am|pm)?$/i
  );
  if (relativeMatch) {
    const anchor = relativeMatch[1].toLowerCase();
    const baseDate = resolveRelativeDate(anchor, reference);
    const explicitTime = parseTimeParts(relativeMatch[2], relativeMatch[3], relativeMatch[4]);
    return buildScheduleResult(baseDate, explicitTime, text, options.defaultHour, duration.minutes, options.allowAllDay);
  }

  const absoluteMatch = text.match(
    /^(?:on\s+)?(\d{4})-(\d{2})-(\d{2})(?:\s+(?:at\s+)?)?(\d{1,2})?(?::(\d{2}))?\s*(am|pm)?$/i
  );
  if (absoluteMatch) {
    const baseDate = new Date(
      Number(absoluteMatch[1]),
      Number(absoluteMatch[2]) - 1,
      Number(absoluteMatch[3]),
      0,
      0,
      0,
      0
    );
    const explicitTime = parseTimeParts(absoluteMatch[4], absoluteMatch[5], absoluteMatch[6]);
    return buildScheduleResult(baseDate, explicitTime, text, options.defaultHour, duration.minutes, options.allowAllDay);
  }

  const timeOnlyMatch = text.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (timeOnlyMatch) {
    const explicitTime = parseTimeParts(timeOnlyMatch[1], timeOnlyMatch[2], timeOnlyMatch[3]);
    if (!explicitTime) {
      return null;
    }

    const baseDate = new Date(reference);
    baseDate.setHours(0, 0, 0, 0);

    const tentative = new Date(baseDate);
    tentative.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
    if (tentative.getTime() <= reference.getTime()) {
      tentative.setDate(tentative.getDate() + 1);
    }

    return buildScheduleResult(
      tentative,
      explicitTime,
      text,
      explicitTime.hour,
      duration.minutes,
      false
    );
  }

  return null;
}

function buildScheduleResult(
  date: Date,
  explicitTime: { hour: number; minute: number } | null,
  parsedFrom: string,
  defaultHour: number,
  durationMinutes: number,
  allowAllDay: boolean
): ScheduleParseResult {
  const startsAt = new Date(date);
  startsAt.setSeconds(0, 0);

  if (!explicitTime && allowAllDay) {
    startsAt.setHours(0, 0, 0, 0);
    return {
      startsAt: startsAt.toISOString(),
      endsAt: null,
      isAllDay: true,
      parsedFrom,
    };
  }

  startsAt.setHours(explicitTime?.hour ?? defaultHour, explicitTime?.minute ?? 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  return {
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    isAllDay: false,
    parsedFrom,
  };
}

function resolveRelativeDate(anchor: string, reference: Date): Date {
  const date = new Date(reference);
  date.setHours(0, 0, 0, 0);

  if (anchor === "today") {
    return date;
  }

  if (anchor === "tomorrow") {
    date.setDate(date.getDate() + 1);
    return date;
  }

  const targetDay = WEEKDAY_INDEX[anchor];
  const currentDay = date.getDay();
  let daysAhead = (targetDay - currentDay + 7) % 7;
  if (daysAhead === 0) {
    daysAhead = 7;
  }
  date.setDate(date.getDate() + daysAhead);
  return date;
}

function parseTimeParts(
  hourText?: string,
  minuteText?: string,
  meridiemText?: string
): { hour: number; minute: number } | null {
  if (!hourText) {
    return null;
  }

  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  const meridiem = meridiemText?.toLowerCase();

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function extractDurationMinutes(text: string, defaultMinutes: number): { text: string; minutes: number } {
  const match = text.match(/\bfor\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i);
  if (!match) {
    return { text, minutes: defaultMinutes };
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const minutes = unit.startsWith("h") ? amount * 60 : amount;

  return {
    text: normalizeAssistantText(text.replace(match[0], "")),
    minutes,
  };
}

function summarizeTitle(text: string, maxLength = 72): string {
  const clean = cleanupSentence(text);
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

function cleanupSentence(text: string): string {
  return normalizeAssistantText(text).replace(/^[,:-]+\s*/, "").replace(/\s+[,:-]+$/, "").trim();
}

function cleanupReminderDescription(text: string): string {
  return cleanupSentence(text).replace(/^(?:to|for|about)\s+/i, "");
}
