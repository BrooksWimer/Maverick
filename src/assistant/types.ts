import type { AssistantModelProfileName, AssistantModelRoutingConfig } from "../config/index.js";

export type AssistantMessageSource = "sms" | "discord" | "api";

export type AssistantPrimaryContext = "work" | "personal" | "home" | "errands" | "health" | "planning";
export type AssistantTaskStatus = "inbox" | "open" | "scheduled" | "done" | "archived";
export type AssistantQueryType = "agenda" | "inbox" | "search";
export type AssistantModelFeature = "classification" | "query" | "summary" | "planning" | "verification" | "review";
export type AssistantModelOverrideScope = "global" | "discord-channel";

export interface AssistantAttachment {
  id?: string | null;
  url?: string | null;
  proxyUrl?: string | null;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface AssistantStructuredNoteInput {
  title?: string | null;
  content?: string | null;
  context?: AssistantPrimaryContext;
}

export type ParsedAssistantIntent =
  | {
      kind: "note";
      title: string;
      content: string;
      confidence: number;
      context?: AssistantPrimaryContext;
    }
  | {
      kind: "task";
      title: string;
      details: string;
      primaryContext: AssistantPrimaryContext;
      status: AssistantTaskStatus;
      dueAt: string | null;
      scheduledFor: string | null;
      confidence: number;
    }
  | {
      kind: "reminder";
      body: string;
      remindAt: string;
      parsedFrom: string;
      confidence: number;
      primaryContext?: AssistantPrimaryContext;
    }
  | {
      kind: "calendar";
      title: string;
      startsAt: string;
      endsAt: string | null;
      isAllDay: boolean;
      recurrenceRule: string | null;
      parsedFrom: string;
      details: string | null;
      location: string | null;
      confidence: number;
      primaryContext?: AssistantPrimaryContext;
    }
  | {
      kind: "query";
      queryType: AssistantQueryType;
      query: string;
      primaryContext?: AssistantPrimaryContext | null;
      confidence: number;
    }
  | {
      kind: "clarification";
      message: string;
      confidence: number;
    };

export interface CalendarEventInput {
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt?: string | null;
  timeZone: string;
  location?: string | null;
  isAllDay?: boolean;
  recurrenceRule?: string | null;
}

export interface CalendarCreateResult {
  provider: string;
  status: "synced" | "pending-config" | "failed";
  providerEventId?: string | null;
  error?: string;
}

export interface SmsSendResult {
  provider: string;
  status: "sent" | "pending-config" | "failed";
  providerMessageId?: string | null;
  error?: string;
}

export interface CalendarProvider {
  readonly name: string;
  createEvent(input: CalendarEventInput): Promise<CalendarCreateResult>;
}

export interface SmsProvider {
  readonly name: string;
  sendMessage(to: string, body: string): Promise<SmsSendResult>;
}

export interface AssistantReplyAttachment {
  name: string;
  content: string;
}

export interface AssistantProcessResult {
  reply: string;
  intent: ParsedAssistantIntent["kind"];
  messageId: string;
  createdRecordId?: string;
  attachment?: AssistantReplyAttachment;
}

export interface ReminderDispatchResult {
  provider: string;
  status: "sent" | "pending-config" | "failed";
  providerMessageId?: string | null;
  error?: string;
}

export interface AssistantTaskSnapshot {
  id: string;
  title: string;
  details: string;
  primaryContext: AssistantPrimaryContext;
  status: AssistantTaskStatus;
  dueAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  noteId: string | null;
  reminderId: string | null;
  calendarEventId: string | null;
}

export interface AssistantCalendarSnapshot {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  location: string | null;
  syncStatus: string;
  recurrenceRule: string | null;
}

export interface AssistantAgendaWorkstreamSnapshot {
  id: string;
  name: string;
  projectId: string;
  state: string;
  currentGoal: string | null;
  summary: string | null;
  updatedAt: string;
}

export interface AssistantAgendaSnapshot {
  generatedAt: string;
  timeZone: string;
  overdueTasks: AssistantTaskSnapshot[];
  dueTodayTasks: AssistantTaskSnapshot[];
  openTasks: AssistantTaskSnapshot[];
  scheduledTasks: AssistantTaskSnapshot[];
  inboxTasks: AssistantTaskSnapshot[];
  upcomingCalendar: AssistantCalendarSnapshot[];
  activeWorkstreams: AssistantAgendaWorkstreamSnapshot[];
  nextAction: string;
}

export interface AssistantSearchResult {
  id: string;
  type: "task" | "note" | "reminder" | "calendar" | "project-memory";
  title: string;
  excerpt: string;
  primaryContext?: AssistantPrimaryContext | null;
  relatedAt?: string | null;
  path?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AssistantModelOverride {
  scope: AssistantModelOverrideScope;
  scopeId: string;
  feature: AssistantModelFeature;
  profile: AssistantModelProfileName;
  updatedAt: string;
}

export interface AssistantModelState {
  routing: AssistantModelRoutingConfig;
  overrides: AssistantModelOverride[];
  effective: Record<AssistantModelFeature, AssistantModelProfileName>;
}

export interface AssistantInterpreter {
  interpret(input: {
    text: string;
    now: Date;
    timeZone: string;
    attachments?: AssistantAttachment[];
    model?: string;
  }): Promise<ParsedAssistantIntent | null>;
  shutdown?(): Promise<void> | void;
}
