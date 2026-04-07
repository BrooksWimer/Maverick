import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { AssistantConfig } from "../config/index.js";
import {
  assistantCalendarEvents,
  assistantMessages,
  assistantNotes,
  assistantReminders,
  events,
} from "../state/index.js";
import { normalizeAssistantText, parseAssistantIntent } from "./parser.js";
import { createCalendarProvider } from "./providers/calendar.js";
import { createSmsProvider } from "./providers/sms.js";
import type {
  AssistantAttachment,
  AssistantMessageSource,
  AssistantInterpreter,
  AssistantProcessResult,
  AssistantStructuredNoteInput,
  CalendarProvider,
  ParsedAssistantIntent,
  ReminderDispatchResult,
  SmsProvider,
  WorkNoteKind,
  WorkNotesConfig,
} from "./types.js";
import {
  normalizeSmartGoalIds,
  normalizeWorkNoteKind,
  persistWorkNote,
} from "./work-notes.js";

const log = createLogger("assistant");

type AssistantServiceOptions = {
  calendarProvider?: CalendarProvider;
  smsProvider?: SmsProvider;
  interpreter?: AssistantInterpreter;
  now?: () => Date;
  workNotes?: WorkNotesConfig | null;
};

type ReminderDispatcher = (params: {
  channel: string;
  destination: string;
  body: string;
}) => Promise<ReminderDispatchResult>;

export class AssistantService {
  private readonly calendarProvider: CalendarProvider;
  private readonly smsProvider: SmsProvider;
  private readonly interpreter: AssistantInterpreter | null;
  private readonly now: () => Date;
  private readonly workNotes: WorkNotesConfig | null;
  private reminderDispatcher: ReminderDispatcher | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AssistantConfig,
    options: AssistantServiceOptions = {}
  ) {
    this.calendarProvider = options.calendarProvider ?? createCalendarProvider(config);
    this.smsProvider = options.smsProvider ?? createSmsProvider(config);
    this.interpreter = options.interpreter ?? null;
    this.now = options.now ?? (() => new Date());
    this.workNotes = options.workNotes ?? null;
  }

  start(): void {
    if (!this.config.enabled || !this.config.reminders.enabled || this.reminderTimer) {
      return;
    }

    this.reminderTimer = setInterval(() => {
      void this.processDueReminders().catch((error) => {
        log.warn({ err: error }, "Assistant reminder sweep failed");
      });
    }, this.config.reminders.pollIntervalMs);

    this.reminderTimer.unref?.();
    log.info({ pollIntervalMs: this.config.reminders.pollIntervalMs }, "Assistant reminder loop started");
  }

  shutdown(): void {
    void this.interpreter?.shutdown?.();
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setReminderDispatcher(dispatcher: ReminderDispatcher): void {
    this.reminderDispatcher = dispatcher;
  }

  async processIncomingMessage(params: {
    source: AssistantMessageSource;
    body: string;
    from?: string | null;
    replyTarget?: string | null;
    attachments?: AssistantAttachment[];
    metadata?: Record<string, unknown>;
    structuredNote?: AssistantStructuredNoteInput;
  }): Promise<AssistantProcessResult> {
    const normalizedBody = normalizeAssistantText(params.body);
    const serializedMetadata =
      params.metadata || (params.attachments?.length ?? 0) > 0
        ? {
            ...(params.metadata ?? {}),
            attachments: params.attachments ?? [],
          }
        : null;
    const metadataJson = serializedMetadata ? JSON.stringify(serializedMetadata) : null;
    const inbound = assistantMessages.create({
      source: params.source,
      direction: "inbound",
      contact: params.from ?? null,
      body: params.body,
      normalized_body: normalizedBody,
      metadata_json: metadataJson,
    });

    events.emit({
      event_type: "assistant.message.received",
      payload: {
        messageId: inbound.id,
        source: params.source,
        contact: params.from ?? null,
      },
      source: "assistant",
    });

    if (!this.isAllowedContact(params.source, params.from ?? null)) {
      const reply =
        params.source === "discord"
          ? "That Discord user is not allowed to control Maverick yet."
          : "That number is not allowed to control Maverick yet.";
      assistantMessages.update(inbound.id, {
        status: "rejected",
        intent: "clarification",
        metadata_json: JSON.stringify({ reason: "contact-not-allowed" }),
      });
      this.recordReply(reply, params.source, params.from ?? null);
      return {
        reply,
        intent: "clarification",
        messageId: inbound.id,
      };
    }

    const referenceTime = this.now();
    let intent: ParsedAssistantIntent;

    if (params.structuredNote) {
      intent = this.buildStructuredNoteIntent(params.structuredNote, normalizedBody, params.attachments ?? []);
    } else {
      try {
        intent =
          (await this.interpreter?.interpret({
            text: normalizedBody,
            now: referenceTime,
            timeZone: this.config.timeZone,
            attachments: params.attachments ?? [],
          })) ??
          parseAssistantIntent(normalizedBody, {
            referenceDate: referenceTime,
            defaultEventDurationMinutes: this.config.calendar.defaultEventDurationMinutes,
            requireTimeForReminders: this.config.reminders.requireTimeForReminders,
            attachments: params.attachments ?? [],
            workSmartGoals: this.workNotes?.smartGoals ?? [],
          });
      } catch (error) {
        log.warn({ err: error }, "Assistant interpreter failed; falling back to parser");
        intent = parseAssistantIntent(normalizedBody, {
          referenceDate: referenceTime,
          defaultEventDurationMinutes: this.config.calendar.defaultEventDurationMinutes,
          requireTimeForReminders: this.config.reminders.requireTimeForReminders,
          attachments: params.attachments ?? [],
          workSmartGoals: this.workNotes?.smartGoals ?? [],
        });
      }
    }

    switch (intent.kind) {
      case "note":
        return this.handleNoteIntent(
          inbound.id,
          params.source,
          params.from ?? null,
          params.attachments ?? [],
          intent
        );
      case "reminder":
        return this.handleReminderIntent(
          inbound.id,
          params.source,
          params.from ?? null,
          params.replyTarget ?? null,
          intent
        );
      case "calendar":
        return this.handleCalendarIntent(inbound.id, params.source, params.from ?? null, intent);
      case "clarification":
      default:
        assistantMessages.update(inbound.id, {
          status: "clarification-needed",
          intent: intent.kind,
          metadata_json: JSON.stringify({ reply: intent.message }),
        });
        this.recordReply(intent.message, params.source, params.from ?? null);
        return {
          reply: intent.message,
          intent: "clarification",
          messageId: inbound.id,
        };
    }
  }

  listNotes(limit = 100) {
    return assistantNotes.listRecent(limit);
  }

  listReminders(limit = 100) {
    return assistantReminders.listRecent(limit);
  }

  listCalendarEvents(limit = 100) {
    return assistantCalendarEvents.listRecent(limit);
  }

  listMessages(limit = 100) {
    return assistantMessages.listRecent(limit);
  }

  async processDueReminders(now = this.now()): Promise<{ sent: number; failed: number }> {
    const due = assistantReminders.listDue(now.toISOString());
    let sent = 0;
    let failed = 0;

    for (const reminder of due) {
      if (!reminder.destination) {
        assistantReminders.markFailed(reminder.id, "Reminder has no configured delivery destination.");
        failed += 1;
        continue;
      }

      const body = `Reminder: ${reminder.body}`;
      const result = await this.dispatchReminder(reminder.channel, reminder.destination, body);

      assistantMessages.create({
        source: reminder.channel === "discord" ? "discord" : "sms",
        direction: "outbound",
        contact: reminder.destination,
        body,
        normalized_body: normalizeAssistantText(body),
        intent: "reminder",
        status: result.status === "sent" ? "sent" : "failed",
        metadata_json: JSON.stringify({
          provider: result.provider,
          providerMessageId: result.providerMessageId ?? null,
          error: result.error ?? null,
          reminderId: reminder.id,
        }),
      });

      if (result.status === "sent") {
        assistantReminders.markSent(reminder.id, result.providerMessageId ?? null);
        sent += 1;
        continue;
      }

      assistantReminders.markFailed(reminder.id, result.error ?? "Reminder delivery failed");
      failed += 1;
    }

    return { sent, failed };
  }

  private async handleNoteIntent(
    inboundMessageId: string,
    source: AssistantMessageSource,
    from: string | null,
    attachments: AssistantAttachment[],
    intent: Extract<ParsedAssistantIntent, { kind: "note" }>
  ): Promise<AssistantProcessResult> {
    const noteId = randomUUID();
    const createdAt = this.now().toISOString();
    const isWorkNote = intent.context === "work" && this.workNotes !== null;
    const noteKind = isWorkNote
      ? normalizeWorkNoteKind(intent.noteKind as WorkNoteKind | undefined, intent.projectName ?? null)
      : null;
    const smartGoalIds = isWorkNote
      ? normalizeSmartGoalIds(intent.smartGoalIds, noteKind!, this.workNotes!)
      : [];

    let storagePath: string | null = null;
    let persistedAttachmentsJson: string | null = null;
    if (isWorkNote) {
      const persisted = await persistWorkNote({
        workNotes: this.workNotes!,
        noteId,
        title: intent.title,
        content: intent.content,
        noteKind: noteKind!,
        projectName: intent.projectName ?? null,
        smartGoalIds,
        source,
        sourceContact: from,
        createdAt,
        attachments,
      });

      storagePath = persisted.storagePath;
      persistedAttachmentsJson = JSON.stringify(persisted.attachments);
    } else if (attachments.length > 0) {
      persistedAttachmentsJson = JSON.stringify(
        attachments.map((attachment) => ({
          originalName: attachment.name ?? "attachment",
          sourceUrl: attachment.url ?? attachment.proxyUrl ?? null,
          contentType: attachment.contentType ?? null,
        }))
      );
    }

    const note = assistantNotes.create({
      id: noteId,
      message_id: inboundMessageId,
      source_contact: from,
      title: intent.title,
      content: intent.content,
      note_context: isWorkNote ? "work" : "general",
      note_kind: noteKind,
      project_name: isWorkNote ? intent.projectName ?? null : null,
      smart_goal_ids_json: smartGoalIds.length > 0 ? JSON.stringify(smartGoalIds) : null,
      attachments_json: persistedAttachmentsJson,
      storage_path: storagePath,
    });

    const reply = buildNoteReply(note.title, {
      isWorkNote,
      noteKind,
      projectName: isWorkNote ? intent.projectName ?? null : null,
      smartGoalIds,
      storagePath,
      attachmentCount: attachments.length,
    });
    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "note",
      metadata_json: JSON.stringify({
        noteId: note.id,
        confidence: intent.confidence,
        noteContext: isWorkNote ? "work" : "general",
        noteKind,
        projectName: isWorkNote ? intent.projectName ?? null : null,
        smartGoalIds,
        storagePath,
      }),
    });

    events.emit({
      event_type: "assistant.note.created",
      payload: {
        messageId: inboundMessageId,
        noteId: note.id,
        title: note.title,
        noteContext: isWorkNote ? "work" : "general",
        noteKind,
        projectName: isWorkNote ? intent.projectName ?? null : null,
      },
      source: "assistant",
    });

    this.recordReply(reply, source, from);

    return {
      reply,
      intent: "note",
      messageId: inboundMessageId,
      createdRecordId: note.id,
    };
  }

  private buildStructuredNoteIntent(
    structuredNote: AssistantStructuredNoteInput,
    normalizedBody: string,
    attachments: AssistantAttachment[]
  ): ParsedAssistantIntent {
    const content = normalizeAssistantText(structuredNote.content ?? normalizedBody);
    const explicitTitle = normalizeAssistantText(structuredNote.title ?? "");
    const hasAttachments = attachments.length > 0;

    if (!content && !explicitTitle && !hasAttachments) {
      return {
        kind: "clarification",
        message: "Add note text or an attachment so I have something to save.",
        confidence: 0.35,
      };
    }

    const noteKind = structuredNote.noteKind;
    const projectName = normalizeAssistantText(structuredNote.projectName ?? "");

    return {
      kind: "note",
      title: explicitTitle || defaultStructuredNoteTitle(noteKind, projectName || null, content, hasAttachments),
      content: content || explicitTitle || fallbackAttachmentContent(noteKind, projectName || null, attachments),
      confidence: 0.98,
      context: structuredNote.context ?? "work",
      noteKind,
      projectName: projectName || null,
      smartGoalIds: structuredNote.smartGoalIds ?? [],
    };
  }

  private async handleReminderIntent(
    inboundMessageId: string,
    source: AssistantMessageSource,
    from: string | null,
    replyTarget: string | null,
    intent: Extract<ParsedAssistantIntent, { kind: "reminder" }>
  ): Promise<AssistantProcessResult> {
    const destination = this.resolveReminderDestination(source, from, replyTarget);
    const reminder = assistantReminders.create({
      message_id: inboundMessageId,
      source_contact: from,
      body: intent.body,
      remind_at: intent.remindAt,
      channel: this.config.reminders.defaultChannel,
      destination,
      provider: this.providerNameForReminderChannel(this.config.reminders.defaultChannel),
    });

    const timeLabel = formatDateTime(intent.remindAt, this.config.timeZone);
    const deliveryNote =
      destination && this.canDispatchReminderChannel(this.config.reminders.defaultChannel)
        ? ""
        : ` I stored it, but ${this.config.reminders.defaultChannel} delivery still needs a configured route.`;
    const reply = `Reminder scheduled for ${timeLabel}.${deliveryNote}`.trim();

    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "reminder",
      metadata_json: JSON.stringify({
        reminderId: reminder.id,
        parsedFrom: intent.parsedFrom,
        confidence: intent.confidence,
      }),
    });

    events.emit({
      event_type: "assistant.reminder.created",
      payload: {
        messageId: inboundMessageId,
        reminderId: reminder.id,
        remindAt: intent.remindAt,
      },
      source: "assistant",
    });

    this.recordReply(reply, source, from);

    return {
      reply,
      intent: "reminder",
      messageId: inboundMessageId,
      createdRecordId: reminder.id,
    };
  }

  private async handleCalendarIntent(
    inboundMessageId: string,
    source: AssistantMessageSource,
    from: string | null,
    intent: Extract<ParsedAssistantIntent, { kind: "calendar" }>
  ): Promise<AssistantProcessResult> {
    const created = assistantCalendarEvents.create({
      message_id: inboundMessageId,
      source_contact: from,
      title: intent.title,
      details: intent.details,
      starts_at: intent.startsAt,
      ends_at: intent.endsAt,
      timezone: this.config.timeZone,
      location: intent.location,
      provider: this.calendarProvider.name,
      sync_status: "pending",
    });

    const providerResult = await this.calendarProvider.createEvent({
      title: intent.title,
      description: intent.details,
      startsAt: intent.startsAt,
      endsAt: intent.endsAt,
      timeZone: this.config.timeZone,
      location: intent.location,
      isAllDay: intent.isAllDay,
    });

    assistantCalendarEvents.update(created.id, {
      provider: providerResult.provider,
      provider_event_id: providerResult.providerEventId ?? null,
      sync_status: providerResult.status,
      sync_error: providerResult.error ?? null,
    });

    assistantMessages.update(inboundMessageId, {
      status: providerResult.status === "failed" ? "failed" : "processed",
      intent: "calendar",
      metadata_json: JSON.stringify({
        calendarEventId: created.id,
        provider: providerResult.provider,
        providerEventId: providerResult.providerEventId ?? null,
        syncStatus: providerResult.status,
        error: providerResult.error ?? null,
        parsedFrom: intent.parsedFrom,
      }),
    });

    events.emit({
      event_type: "assistant.calendar.created",
      payload: {
        messageId: inboundMessageId,
        calendarEventId: created.id,
        startsAt: intent.startsAt,
        syncStatus: providerResult.status,
      },
      source: "assistant",
    });

    const whenLabel = intent.isAllDay
      ? formatDate(intent.startsAt, this.config.timeZone)
      : formatDateTime(intent.startsAt, this.config.timeZone);
    const reply = buildCalendarReply(intent.title, whenLabel, providerResult.status);

    this.recordReply(reply, source, from);

    return {
      reply,
      intent: "calendar",
      messageId: inboundMessageId,
      createdRecordId: created.id,
    };
  }

  private isAllowedContact(source: AssistantMessageSource, contact: string | null): boolean {
    if (!contact) {
      return true;
    }

    if (source === "discord") {
      const configured = new Set([
        ...this.config.discord.allowedUserIds,
        ...parseEnvList(process.env.ASSISTANT_ALLOWED_DISCORD_USER_IDS),
      ]);
      return configured.size === 0 ? true : configured.has(contact);
    }

    if (source === "sms") {
      const configured = new Set([
        ...this.config.allowedPhoneNumbers,
        ...parseEnvList(process.env.ASSISTANT_ALLOWED_PHONE_NUMBERS),
      ]);
      return configured.size === 0 ? true : configured.has(contact);
    }

    return true;
  }

  private recordReply(reply: string, source: AssistantMessageSource, contact: string | null): void {
    if (!reply) {
      return;
    }

    if (source === "sms" && !this.config.sms.replyToInbound) {
      return;
    }

    assistantMessages.create({
      source,
      direction: "outbound",
      contact,
      body: reply,
      normalized_body: normalizeAssistantText(reply),
      intent: "reply",
      status: "sent",
    });
  }

  private resolveReminderDestination(
    source: AssistantMessageSource,
    from: string | null,
    replyTarget: string | null
  ): string | null {
    if (this.config.reminders.defaultChannel === "discord") {
      return replyTarget;
    }

    if (source === "discord") {
      return null;
    }

    return from;
  }

  private providerNameForReminderChannel(channel: string): string {
    if (channel === "discord") {
      return "discord";
    }
    return this.smsProvider.name;
  }

  private canDispatchReminderChannel(channel: string): boolean {
    if (channel === "discord") {
      return this.reminderDispatcher !== null;
    }
    return this.smsProvider.name !== "disabled";
  }

  private async dispatchReminder(
    channel: string,
    destination: string,
    body: string
  ): Promise<ReminderDispatchResult> {
    if (channel === "discord") {
      if (!this.reminderDispatcher) {
        return {
          provider: "discord",
          status: "pending-config",
          error: "Discord reminder dispatcher is not configured.",
        };
      }
      return this.reminderDispatcher({ channel, destination, body });
    }

    return this.smsProvider.sendMessage(destination, body);
  }
}

function buildNoteReply(
  title: string,
  params: {
    isWorkNote: boolean;
    noteKind: WorkNoteKind | null;
    projectName: string | null;
    smartGoalIds: string[];
    storagePath: string | null;
    attachmentCount: number;
  }
): string {
  if (!params.isWorkNote) {
    return `Saved note: "${title}"`;
  }

  const details = [
    params.noteKind ? `kind: ${params.noteKind}` : null,
    params.projectName ? `project: ${params.projectName}` : null,
    params.smartGoalIds.length > 0 ? `smart goals: ${params.smartGoalIds.join(", ")}` : null,
    params.attachmentCount > 0 ? `attachments: ${params.attachmentCount}` : null,
  ].filter(Boolean);

  return [
    `Saved work note: "${title}"`,
    details.length > 0 ? `(${details.join("; ")})` : null,
    params.storagePath ? `File: ${params.storagePath}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function defaultStructuredNoteTitle(
  noteKind: WorkNoteKind | undefined,
  projectName: string | null,
  content: string,
  hasAttachments: boolean
): string {
  const trimmed = content.trim();
  if (trimmed) {
    return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
  }

  switch (noteKind) {
    case "acceptance-criteria":
      return projectName ? `${projectName} acceptance criteria` : "Acceptance criteria capture";
    case "study":
      return projectName ? `${projectName} study note` : "Study note";
    case "project":
      return projectName ? `${projectName} project note` : "Project note";
    case "general":
    default:
      return hasAttachments ? "Work attachment note" : "Work note";
  }
}

function fallbackAttachmentContent(
  noteKind: WorkNoteKind | undefined,
  projectName: string | null,
  attachments: AssistantAttachment[]
): string {
  const attachmentNames = attachments.map((attachment) => attachment.name ?? "attachment").join(", ");
  const prefix =
    noteKind === "acceptance-criteria"
      ? "Acceptance criteria attachment"
      : noteKind === "study"
        ? "Study attachment"
        : noteKind === "project"
          ? "Project attachment"
          : "Work attachment";

  return `${prefix}${projectName ? ` for ${projectName}` : ""}: ${attachmentNames}`;
}

function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
  }).format(new Date(iso));
}

function buildCalendarReply(title: string, whenLabel: string, status: "synced" | "pending-config" | "failed"): string {
  if (status === "synced") {
    return `Calendar event created: "${title}" on ${whenLabel}.`;
  }
  if (status === "pending-config") {
    return `Captured "${title}" for ${whenLabel}, but calendar sync still needs provider setup.`;
  }
  return `I saved "${title}" for ${whenLabel}, but the calendar provider reported an error.`;
}

function parseEnvList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
}
