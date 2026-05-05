import type {
  AssistantAttachment,
  AssistantPrimaryContext,
  AssistantTaskStatus,
  ParsedAssistantIntent,
} from "./types.js";

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
  attachments?: AssistantAttachment[];
};

type ScheduleParseResult = {
  startsAt: string;
  endsAt: string | null;
  isAllDay: boolean;
  recurrenceRule?: string | null;
  parsedFrom: string;
};

type TaskScheduleParseResult = {
  dueAt: string | null;
  scheduledFor: string | null;
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
  const hasAttachments = (options.attachments?.length ?? 0) > 0;
  if (!normalized && !hasAttachments) {
    return {
      kind: "clarification",
      message: "Send a note, task, reminder, calendar item, or question with some text so I can help.",
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

  const query = parseQueryIntent(normalized);
  if (query) {
    return query;
  }

  const task = parseTaskIntent(normalized, options);
  if (task) {
    return task;
  }

  return parseNoteIntent(normalized, options);
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
      message: "I can set that reminder, but I need to know what you want me to remember.",
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
    primaryContext: inferPrimaryContext(split.description, options.attachments ?? []),
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
  const split = splitCalendarDescriptionAndSchedule(remainder);
  if (!split.scheduleText) {
    return {
      kind: "clarification",
      message: "I can add that to your calendar, but I need a date like 'tomorrow at 3pm' or '2026-04-06'.",
      confidence: 0.52,
    };
  }

  const scheduled = parseCalendarScheduleText(split.scheduleText, {
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
    recurrenceRule: scheduled.recurrenceRule ?? null,
    parsedFrom: scheduled.parsedFrom,
    details: text,
    location: null,
    confidence: 0.83,
    primaryContext: inferPrimaryContext(split.description, options.attachments ?? []),
  };
}

function parseQueryIntent(text: string): ParsedAssistantIntent | null {
  const normalized = text.toLowerCase();

  if (
    /^(?:show|open|give me)\s+(?:my\s+)?inbox\b/.test(normalized) ||
    /^(?:what(?:'s| is)\s+in\s+my\s+inbox)\b/.test(normalized)
  ) {
    return {
      kind: "query",
      queryType: "inbox",
      query: "inbox",
      primaryContext: extractContextHint(text),
      confidence: 0.86,
    };
  }

  if (
    /^(?:show|open|give me)\s+(?:my\s+)?agenda\b/.test(normalized) ||
    /^(?:what do i need to do(?: today)?|what(?:'s| is) due(?: today)?|resume me)\b/.test(normalized)
  ) {
    return {
      kind: "query",
      queryType: "agenda",
      query: "agenda",
      primaryContext: extractContextHint(text),
      confidence: 0.88,
    };
  }

  const searchMatch = text.match(
    /^(?:find|search(?: for)?|look up|what did i say about|what do i have about)\s+(.+)$/i
  );
  if (searchMatch?.[1]) {
    return {
      kind: "query",
      queryType: "search",
      query: cleanupSentence(searchMatch[1]),
      primaryContext: extractContextHint(text),
      confidence: 0.84,
    };
  }

  return null;
}

function parseTaskIntent(
  text: string,
  options: ParseAssistantIntentOptions
): ParsedAssistantIntent | null {
  const content = cleanupSentence(text);
  if (!content) {
    return null;
  }

  const normalized = content.toLowerCase();
  const explicitTaskPrefix = /^(?:task|todo|to-do|follow up|follow-up)[:\s-]+/i.test(content);
  const actionable = explicitTaskPrefix || looksActionable(normalized);
  if (!actionable) {
    return null;
  }

  const cleanedContent = cleanupSentence(content.replace(/^(?:task|todo|to-do)[:\s-]+/i, ""));
  const split = splitDescriptionAndSchedule(cleanedContent);
  const schedule = split.scheduleText
    ? parseTaskScheduleText(split.scheduleText, {
        referenceDate: options.referenceDate,
        defaultHour: options.defaultReminderHour ?? 9,
        defaultDurationMinutes: options.defaultEventDurationMinutes ?? 30,
      })
    : null;

  const details = split.description || cleanedContent;
  const primaryContext = inferPrimaryContext(details, options.attachments ?? []);
  const status = inferTaskStatus(details, schedule, explicitTaskPrefix);

  return {
    kind: "task",
    title: summarizeTitle(details),
    details,
    primaryContext,
    status,
    dueAt: schedule?.dueAt ?? null,
    scheduledFor: schedule?.scheduledFor ?? null,
    confidence: status === "inbox" ? 0.7 : 0.78,
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

function parseNoteIntent(text: string, options: ParseAssistantIntentOptions): ParsedAssistantIntent {
  const attachments = options.attachments ?? [];
  const fallbackContent =
    attachments.length > 0
      ? `Attachment note captured: ${attachments.map((attachment) => attachment.name ?? "attachment").join(", ")}`
      : text;
  const content = text.replace(/^(?:note|remember|memo)[:\s-]*/i, "").trim() || fallbackContent;
  const context = inferPrimaryContext(content, attachments);

  return {
    kind: "note",
    title: summarizeTitle(content),
    content,
    confidence: context === "work" ? 0.72 : 0.75,
    context,
  };
}

function inferTaskStatus(
  description: string,
  schedule: TaskScheduleParseResult | null,
  explicitTaskPrefix: boolean
): AssistantTaskStatus {
  if (schedule?.dueAt || schedule?.scheduledFor) {
    return "scheduled";
  }

  if (explicitTaskPrefix || /^(?:finish|write|review|submit|call|email|schedule|book|renew|pay|draft|update|prepare)\b/i.test(description)) {
    return "open";
  }

  return "inbox";
}

function looksActionable(text: string): boolean {
  return [
    /^(?:i need to|need to|i should|should|remember to)\b/,
    /^(?:pick up|drop off|buy|call|email|text|schedule|book|renew|pay|ask|check|finish|plan|research|figure out|review|write|send|submit|follow up|clean|organize|order)\b/,
    /\b(?:todo|to do|follow up|errand|task)\b/,
  ].some((pattern) => pattern.test(text));
}

export function inferPrimaryContext(
  content: string,
  attachments: AssistantAttachment[] = []
): AssistantPrimaryContext {
  const normalized = normalizeAssistantText(content).toLowerCase();
  const attachmentLabel = attachments
    .map((attachment) => `${attachment.name ?? ""} ${attachment.contentType ?? ""}`.trim().toLowerCase())
    .join(" ");

  if (
    /\b(work|project|ticket|workstream|repo|deploy|deployment|codex|claude|discord bot|client|sprint|retro|standup|feature|bug|pr|pull request|server|production|meeting with team)\b/.test(normalized)
  ) {
    return "work";
  }

  if (/\b(dentist|doctor|therapy|medication|medicine|vitamin|workout|gym|health|appointment|prescription)\b/.test(normalized)) {
    return "health";
  }

  if (/\b(grocery|dry cleaning|pharmacy|bank|store|post office|shipping|mail|errand|pickup|dropoff|buy|return|shopping)\b/.test(normalized)) {
    return "errands";
  }

  if (/\b(home|house|apartment|rent|landlord|contractor|plumber|electrician|laundry|cleaning|yard|garage|kitchen)\b/.test(normalized)) {
    return "home";
  }

  if (/\b(plan|planning|review week|roadmap|brainstorm|organize|triage|decide|research)\b/.test(normalized)) {
    return "planning";
  }

  if (/\b(work|ticket|study|acceptance|criteria)\b/.test(attachmentLabel)) {
    return "work";
  }

  return "personal";
}

function extractContextHint(text: string): AssistantPrimaryContext | null {
  const lowered = normalizeAssistantText(text).toLowerCase();
  for (const context of ["work", "personal", "home", "errands", "health", "planning"] as AssistantPrimaryContext[]) {
    if (new RegExp(`\\b${context}\\b`).test(lowered)) {
      return context;
    }
  }

  return null;
}

function splitDescriptionAndSchedule(text: string): {
  description: string;
  scheduleText: string | null;
} {
  const patterns = [
    /\b(?:on\s+)?\d{4}-\d{2}-\d{2}\b/i,
    /\b(?:on\s+)?(?:today|tomorrow)\b/i,
    /\b(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    /\b(?:by|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
    /\bby\s+\d{4}-\d{2}-\d{2}\b/i,
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

function splitCalendarDescriptionAndSchedule(text: string): {
  description: string;
  scheduleText: string | null;
} {
  const recurringIndex = findRecurringScheduleIndex(text);
  if (recurringIndex >= 0) {
    return {
      description: cleanupSentence(text.slice(0, recurringIndex)),
      scheduleText: cleanupSentence(text.slice(recurringIndex)),
    };
  }

  return splitDescriptionAndSchedule(text);
}

function parseTaskScheduleText(
  raw: string,
  options: {
    referenceDate?: Date;
    defaultHour: number;
    defaultDurationMinutes: number;
  }
): TaskScheduleParseResult | null {
  const normalized = cleanupSentence(raw).replace(/^by\s+/i, "");
  const scheduled = parseScheduleText(normalized, {
    referenceDate: options.referenceDate,
    defaultHour: options.defaultHour,
    defaultDurationMinutes: options.defaultDurationMinutes,
    allowAllDay: true,
  });

  if (!scheduled) {
    return null;
  }

  return {
    dueAt: scheduled.startsAt,
    scheduledFor: scheduled.isAllDay ? null : scheduled.startsAt,
    parsedFrom: scheduled.parsedFrom,
  };
}

function parseCalendarScheduleText(
  raw: string,
  options: {
    referenceDate?: Date;
    defaultHour: number;
    defaultDurationMinutes: number;
    allowAllDay: boolean;
  }
): ScheduleParseResult | null {
  return parseRecurringScheduleText(raw, options) ?? parseScheduleText(raw, options);
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
  const text = cleanupSentence(duration.text).replace(/^by\s+/i, "");

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

function parseRecurringScheduleText(
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
  const timeMatch = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const explicitTime = timeMatch ? parseTimeParts(timeMatch[1], timeMatch[2], timeMatch[3]) : null;
  const normalized = cleanupSentence(
    text.replace(/\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i, "")
  ).toLowerCase();

  if (normalized === "daily" || normalized === "every day") {
    const firstDate = resolveRecurringDate(reference, null, explicitTime, options.defaultHour);
    return buildRecurringScheduleResult(
      firstDate,
      explicitTime,
      text,
      options.defaultHour,
      duration.minutes,
      options.allowAllDay,
      "RRULE:FREQ=DAILY"
    );
  }

  if (["every weekday", "every workday", "every workweek"].includes(normalized)) {
    const firstDate = resolveRecurringDate(reference, [1, 2, 3, 4, 5], explicitTime, options.defaultHour);
    return buildRecurringScheduleResult(
      firstDate,
      explicitTime,
      text,
      options.defaultHour,
      duration.minutes,
      options.allowAllDay,
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
    );
  }

  if (normalized === "every weekend") {
    const firstDate = resolveRecurringDate(reference, [0, 6], explicitTime, options.defaultHour);
    return buildRecurringScheduleResult(
      firstDate,
      explicitTime,
      text,
      options.defaultHour,
      duration.minutes,
      options.allowAllDay,
      "RRULE:FREQ=WEEKLY;BYDAY=SA,SU"
    );
  }

  const weekdayListMatch = normalized.match(
    /^every\s+((?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*(?:,|and)\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))*)$/
  );
  if (weekdayListMatch?.[1]) {
    const weekdayNames = weekdayListMatch[1]
      .split(/\s*(?:,|and)\s*/i)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const weekdayNumbers = weekdayNames
      .map((name) => WEEKDAY_INDEX[name])
      .filter((value): value is number => value !== undefined);
    if (weekdayNumbers.length > 0) {
      const firstDate = resolveRecurringDate(reference, weekdayNumbers, explicitTime, options.defaultHour);
      return buildRecurringScheduleResult(
        firstDate,
        explicitTime,
        text,
        options.defaultHour,
        duration.minutes,
        options.allowAllDay,
        `RRULE:FREQ=WEEKLY;BYDAY=${weekdayNumbers.map(toRruleDay).join(",")}`
      );
    }
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

function buildRecurringScheduleResult(
  date: Date,
  explicitTime: { hour: number; minute: number } | null,
  parsedFrom: string,
  defaultHour: number,
  durationMinutes: number,
  allowAllDay: boolean,
  recurrenceRule: string
): ScheduleParseResult {
  return {
    ...buildScheduleResult(date, explicitTime, parsedFrom, defaultHour, durationMinutes, allowAllDay),
    recurrenceRule,
  };
}

function resolveRecurringDate(
  reference: Date,
  allowedDays: number[] | null,
  explicitTime: { hour: number; minute: number } | null,
  defaultHour: number
): Date {
  const hour = explicitTime?.hour ?? defaultHour;
  const minute = explicitTime?.minute ?? 0;

  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = new Date(reference);
    candidate.setHours(0, 0, 0, 0);
    candidate.setDate(candidate.getDate() + offset);

    if (allowedDays && !allowedDays.includes(candidate.getDay())) {
      continue;
    }

    candidate.setHours(hour, minute, 0, 0);
    if (offset > 0 || candidate.getTime() > reference.getTime()) {
      return candidate;
    }
  }

  const fallback = new Date(reference);
  fallback.setHours(hour, minute, 0, 0);
  fallback.setDate(fallback.getDate() + 1);
  return fallback;
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

function toRruleDay(day: number): string {
  switch (day) {
    case 0:
      return "SU";
    case 1:
      return "MO";
    case 2:
      return "TU";
    case 3:
      return "WE";
    case 4:
      return "TH";
    case 5:
      return "FR";
    case 6:
      return "SA";
    default:
      return "MO";
  }
}

function findRecurringScheduleIndex(text: string): number {
  const normalized = text.toLowerCase();
  const literalPhrases = [
    " daily",
    " every day",
    " every weekday",
    " every workday",
    " every workweek",
    " every weekend",
  ];

  let earliest = Number.POSITIVE_INFINITY;
  for (const phrase of literalPhrases) {
    const index = normalized.indexOf(phrase);
    if (index >= 0) {
      earliest = Math.min(earliest, index + 1);
    }
  }

  const weekdayPattern =
    /\bevery\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:\s*(?:,|and)\s*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))*(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm))?/i;
  const weekdayMatch = weekdayPattern.exec(text);
  if (weekdayMatch?.index !== undefined) {
    earliest = Math.min(earliest, weekdayMatch.index);
  }

  return Number.isFinite(earliest) ? earliest : -1;
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
