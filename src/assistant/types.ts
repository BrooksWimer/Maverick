export type AssistantMessageSource = "sms" | "discord" | "api";

export type ParsedAssistantIntent =
  | {
      kind: "note";
      title: string;
      content: string;
      confidence: number;
    }
  | {
      kind: "reminder";
      body: string;
      remindAt: string;
      parsedFrom: string;
      confidence: number;
    }
  | {
      kind: "calendar";
      title: string;
      startsAt: string;
      endsAt: string | null;
      isAllDay: boolean;
      parsedFrom: string;
      details: string | null;
      location: string | null;
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

export interface AssistantProcessResult {
  reply: string;
  intent: ParsedAssistantIntent["kind"];
  messageId: string;
  createdRecordId?: string;
}

export interface ReminderDispatchResult {
  provider: string;
  status: "sent" | "pending-config" | "failed";
  providerMessageId?: string | null;
  error?: string;
}

export interface AssistantInterpreter {
  interpret(input: {
    text: string;
    now: Date;
    timeZone: string;
  }): Promise<ParsedAssistantIntent | null>;
  shutdown?(): Promise<void> | void;
}
