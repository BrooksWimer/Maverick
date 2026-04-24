import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type { AssistantConfig, AssistantModelProfileName } from "../config/index.js";
import {
  artifacts,
  assistantCalendarEvents,
  assistantMessages,
  assistantNotes,
  assistantReminders,
  assistantSettings,
  assistantTasks,
  events,
  workstreams,
} from "../state/index.js";
import { normalizeAssistantText, parseAssistantIntent } from "./parser.js";
import { createCalendarProvider } from "./providers/calendar.js";
import { createSmsProvider } from "./providers/sms.js";
import { buildAgendaSummary, normalizeStoredContext, renderAgendaMarkdown, renderInboxMarkdown, renderSearchMarkdown } from "./render.js";
import type {
  AssistantAgendaSnapshot,
  AssistantAttachment,
  AssistantCalendarSnapshot,
  AssistantMessageSource,
  AssistantInterpreter,
  AssistantModelFeature,
  AssistantModelOverride,
  AssistantModelOverrideScope,
  AssistantModelState,
  AssistantPrimaryContext,
  AssistantProcessResult,
  AssistantSearchResult,
  AssistantStructuredNoteInput,
  AssistantTaskSnapshot,
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

type AssistantMirror = {
  queueSync(reason: string): void;
};

type AssistantServiceOptions = {
  calendarProvider?: CalendarProvider;
  smsProvider?: SmsProvider;
  interpreter?: AssistantInterpreter;
  now?: () => Date;
  workNotes?: WorkNotesConfig | null;
  mirror?: AssistantMirror | null;
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
  private readonly mirror: AssistantMirror | null;
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
    this.mirror = options.mirror ?? null;
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
    const requestedProfile = params.structuredNote ? null : this.extractRequestedProfile(params.body);
    const cleanedBody = requestedProfile ? this.stripModelPrefix(params.body) : params.body;
    const normalizedBody = normalizeAssistantText(cleanedBody);
    const serializedMetadata =
      params.metadata || (params.attachments?.length ?? 0) > 0 || requestedProfile
        ? {
            ...(params.metadata ?? {}),
            attachments: params.attachments ?? [],
            requestedProfile,
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
            model: this.resolveModel("classification", {
              source: params.source,
              channelId: this.readChannelId(params.metadata),
              requestedProfile,
            }),
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
      case "task":
        return this.handleTaskIntent(inbound.id, params.source, params.from ?? null, intent);
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
      case "query":
        return this.handleQueryIntent(inbound.id, params.source, params.from ?? null, intent);
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

  listTasks(limit = 100) {
    return assistantTasks.listRecent(limit);
  }

  listInbox(limit = 100, context?: AssistantPrimaryContext) {
    const tasks = assistantTasks.listByStatus("inbox", limit * 2)
      .map((task) => this.toTaskSnapshot(task))
      .filter((task) => !context || task.primaryContext === context);
    return tasks.slice(0, limit);
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

  getAgenda(context?: AssistantPrimaryContext, now = this.now()): AssistantAgendaSnapshot {
    const referenceIso = now.toISOString();
    const tasks = assistantTasks.listRecent(500)
      .filter((task) => !["done", "archived"].includes(task.status))
      .map((task) => this.toTaskSnapshot(task))
      .filter((task) => !context || task.primaryContext === context);

    const overdueTasks = tasks.filter((task) => task.dueAt !== null && task.dueAt < referenceIso && task.status !== "scheduled");
    const dueTodayTasks = tasks.filter((task) => task.dueAt !== null && task.dueAt >= referenceIso && isSameLocalDay(task.dueAt, now, this.config.timeZone));
    const openTasks = tasks.filter((task) => task.status === "open");
    const scheduledTasks = tasks.filter((task) => task.status === "scheduled" && (task.scheduledFor ?? task.dueAt ?? "") >= referenceIso);
    const inboxTasks = tasks.filter((task) => task.status === "inbox");
    const upcomingCalendar = assistantCalendarEvents.listUpcoming(referenceIso, 20)
      .map((event) => this.toCalendarSnapshot(event))
      .filter((event) => !context || normalizeStoredContext(event.metadata?.primaryContext as string | undefined) === context);
    const activeWorkstreams = workstreams.listActive()
      .slice(0, 6)
      .map((workstream) => ({
        id: workstream.id,
        name: workstream.name,
        projectId: workstream.project_id,
        state: workstream.state,
        currentGoal: workstream.current_goal,
        summary: workstream.summary,
        updatedAt: workstream.last_activity_at,
      }));

    const nextAction = this.buildAgendaNextAction({
      overdueTasks,
      dueTodayTasks,
      openTasks,
      scheduledTasks,
      inboxTasks,
      upcomingCalendar,
      activeWorkstreams,
    });

    return {
      generatedAt: referenceIso,
      timeZone: this.config.timeZone,
      overdueTasks,
      dueTodayTasks,
      openTasks,
      scheduledTasks,
      inboxTasks,
      upcomingCalendar,
      activeWorkstreams,
      nextAction,
    };
  }

  search(query: string, options: { context?: AssistantPrimaryContext; limit?: number } = {}): AssistantSearchResult[] {
    const normalizedQuery = normalizeAssistantText(query).toLowerCase();
    const limit = options.limit ?? 12;
    const results: AssistantSearchResult[] = [];

    for (const task of assistantTasks.listRecent(200)) {
      if (!matchesSearch([task.title, task.details], normalizedQuery)) {
        continue;
      }
      const context = normalizeStoredContext(task.primary_context);
      if (options.context && context !== options.context) {
        continue;
      }
      results.push({
        id: task.id,
        type: "task",
        title: task.title,
        excerpt: task.details,
        primaryContext: context,
        relatedAt: task.updated_at,
      });
    }

    for (const note of assistantNotes.listRecent(200)) {
      if (!matchesSearch([note.title, note.content, note.project_name ?? ""], normalizedQuery)) {
        continue;
      }
      const context = normalizeStoredContext(note.note_context);
      if (options.context && context !== options.context) {
        continue;
      }
      results.push({
        id: note.id,
        type: "note",
        title: note.title,
        excerpt: note.content,
        primaryContext: context,
        relatedAt: note.created_at,
        path: note.storage_path ?? null,
      });
    }

    for (const reminder of assistantReminders.listRecent(200)) {
      if (!matchesSearch([reminder.body], normalizedQuery)) {
        continue;
      }
      results.push({
        id: reminder.id,
        type: "reminder",
        title: reminder.body,
        excerpt: `Reminder scheduled for ${formatDateTime(reminder.remind_at, this.config.timeZone)}`,
        relatedAt: reminder.remind_at,
      });
    }

    for (const event of assistantCalendarEvents.listRecent(200)) {
      if (!matchesSearch([event.title, event.details ?? "", event.location ?? ""], normalizedQuery)) {
        continue;
      }
      results.push({
        id: event.id,
        type: "calendar",
        title: event.title,
        excerpt: event.details ?? `Calendar event at ${formatDateTime(event.starts_at, this.config.timeZone)}`,
        relatedAt: event.starts_at,
      });
    }

    for (const artifact of artifacts.listRecent(100, "operator-report")) {
      const metadata = parseJsonRecord(artifact.metadata_json);
      const summary = typeof metadata.summary === "string" ? metadata.summary : "";
      const headline = typeof metadata.headline === "string" ? metadata.headline : artifact.name;
      if (!matchesSearch([headline, summary, artifact.content ?? ""], normalizedQuery)) {
        continue;
      }
      results.push({
        id: artifact.id,
        type: "project-memory",
        title: headline,
        excerpt: summary || artifact.content?.slice(0, 240) || "Project memory artifact",
        relatedAt: artifact.created_at,
        path: artifact.path ?? null,
        metadata: {
          workstreamId: artifact.workstream_id,
          kind: metadata.kind,
        },
      });
    }

    return dedupeSearchResults(results).slice(0, limit);
  }

  async completeTask(taskId: string): Promise<AssistantTaskSnapshot> {
    const task = assistantTasks.getById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const completed = assistantTasks.update(taskId, {
      status: "done",
      completed_at: this.now().toISOString(),
    });
    events.emit({
      event_type: "assistant.task.completed",
      payload: {
        taskId,
      },
      source: "assistant",
    });
    this.queueMirrorSync("assistant.task.completed");
    return this.toTaskSnapshot(completed!);
  }

  async snoozeTask(taskId: string, whenIso: string): Promise<AssistantTaskSnapshot> {
    const task = assistantTasks.getById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const updated = assistantTasks.update(taskId, {
      status: "scheduled",
      due_at: whenIso,
      scheduled_for: whenIso,
      completed_at: null,
    });

    if (task.reminder_id) {
      assistantReminders.update(task.reminder_id, {
        remind_at: whenIso,
        status: "scheduled",
        error: null,
      });
    }

    events.emit({
      event_type: "assistant.task.snoozed",
      payload: {
        taskId,
        whenIso,
      },
      source: "assistant",
    });
    this.queueMirrorSync("assistant.task.snoozed");
    return this.toTaskSnapshot(updated!);
  }

  async retagItem(itemId: string, context: AssistantPrimaryContext): Promise<{ type: "task" | "note"; id: string }> {
    const task = assistantTasks.getById(itemId);
    if (task) {
      assistantTasks.update(itemId, {
        primary_context: context,
      });
      events.emit({
        event_type: "assistant.task.retagged",
        payload: {
          taskId: itemId,
          context,
        },
        source: "assistant",
      });
      this.queueMirrorSync("assistant.task.retagged");
      return { type: "task", id: itemId };
    }

    const note = assistantNotes.getById(itemId);
    if (note) {
      assistantNotes.update(itemId, {
        note_context: context,
      });
      events.emit({
        event_type: "assistant.note.retagged",
        payload: {
          noteId: itemId,
          context,
        },
        source: "assistant",
      });
      this.queueMirrorSync("assistant.note.retagged");
      return { type: "note", id: itemId };
    }

    throw new Error(`Assistant item not found: ${itemId}`);
  }

  getModelState(scope?: { source?: AssistantMessageSource; channelId?: string | null }): AssistantModelState {
    const overrides = assistantSettings.list().map((row) => ({
      scope: row.scope_type as AssistantModelOverrideScope,
      scopeId: row.scope_id,
      feature: row.feature as AssistantModelFeature,
      profile: row.profile as AssistantModelProfileName,
      updatedAt: row.updated_at,
    }));

    const effective = {
      classification: this.resolveProfile("classification", scope),
      query: this.resolveProfile("query", scope),
      summary: this.resolveProfile("summary", scope),
      planning: this.resolveProfile("planning", scope),
      verification: this.resolveProfile("verification", scope),
      review: this.resolveProfile("review", scope),
    };

    return {
      routing: this.config.modelRouting,
      overrides,
      effective,
    };
  }

  setModelOverride(params: {
    scope: AssistantModelOverrideScope;
    scopeId: string;
    feature: AssistantModelFeature;
    profile: AssistantModelProfileName;
  }): AssistantModelOverride {
    const row = assistantSettings.upsert({
      scope_type: params.scope,
      scope_id: params.scopeId,
      feature: params.feature,
      profile: params.profile,
    });

    this.queueMirrorSync("assistant.model-override.updated");
    return {
      scope: row.scope_type as AssistantModelOverrideScope,
      scopeId: row.scope_id,
      feature: row.feature as AssistantModelFeature,
      profile: row.profile as AssistantModelProfileName,
      updatedAt: row.updated_at,
    };
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

    if (sent > 0 || failed > 0) {
      this.queueMirrorSync("assistant.reminders.processed");
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
    const normalizedContext = intent.context ?? "personal";
    const isWorkNote = normalizedContext === "work" && this.workNotes !== null;
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
      note_context: normalizedContext,
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
      context: normalizedContext,
    });
    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "note",
      metadata_json: JSON.stringify({
        noteId: note.id,
        confidence: intent.confidence,
        noteContext: normalizedContext,
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
        noteContext: normalizedContext,
        noteKind,
        projectName: isWorkNote ? intent.projectName ?? null : null,
      },
      source: "assistant",
    });

    this.recordReply(reply, source, from);
    this.queueMirrorSync("assistant.note.created");

    return {
      reply,
      intent: "note",
      messageId: inboundMessageId,
      createdRecordId: note.id,
    };
  }

  private async handleTaskIntent(
    inboundMessageId: string,
    source: AssistantMessageSource,
    from: string | null,
    intent: Extract<ParsedAssistantIntent, { kind: "task" }>
  ): Promise<AssistantProcessResult> {
    const task = assistantTasks.create({
      message_id: inboundMessageId,
      source_contact: from,
      title: intent.title,
      details: intent.details,
      primary_context: intent.primaryContext,
      status: intent.status,
      due_at: intent.dueAt,
      scheduled_for: intent.scheduledFor,
    });

    const reply = buildTaskReply(task.title, task.status, task.primary_context, task.due_at, this.config.timeZone);
    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "task",
      metadata_json: JSON.stringify({
        taskId: task.id,
        confidence: intent.confidence,
        primaryContext: intent.primaryContext,
        status: intent.status,
        dueAt: intent.dueAt,
        scheduledFor: intent.scheduledFor,
      }),
    });

    events.emit({
      event_type: "assistant.task.created",
      payload: {
        messageId: inboundMessageId,
        taskId: task.id,
        status: task.status,
        primaryContext: task.primary_context,
      },
      source: "assistant",
    });

    this.recordReply(reply, source, from);
    this.queueMirrorSync("assistant.task.created");

    return {
      reply,
      intent: "task",
      messageId: inboundMessageId,
      createdRecordId: task.id,
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
    const task = assistantTasks.create({
      message_id: inboundMessageId,
      source_contact: from,
      title: summarizeTaskTitle(intent.body),
      details: intent.body,
      primary_context: intent.primaryContext ?? "personal",
      status: "scheduled",
      due_at: intent.remindAt,
      scheduled_for: intent.remindAt,
      reminder_id: reminder.id,
    });

    const timeLabel = formatDateTime(intent.remindAt, this.config.timeZone);
    const deliveryNote =
      destination && this.canDispatchReminderChannel(this.config.reminders.defaultChannel)
        ? ""
        : ` I stored it, but ${this.config.reminders.defaultChannel} delivery still needs a configured route.`;
    const reply = `Reminder scheduled for ${timeLabel}. Linked task: "${task.title}".${deliveryNote}`.trim();

    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "reminder",
      metadata_json: JSON.stringify({
        reminderId: reminder.id,
        taskId: task.id,
        parsedFrom: intent.parsedFrom,
        confidence: intent.confidence,
      }),
    });

    events.emit({
      event_type: "assistant.reminder.created",
      payload: {
        messageId: inboundMessageId,
        reminderId: reminder.id,
        taskId: task.id,
        remindAt: intent.remindAt,
      },
      source: "assistant",
    });

    this.recordReply(reply, source, from);
    this.queueMirrorSync("assistant.reminder.created");

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

    let linkedTaskId: string | null = null;
    if (shouldCreateTaskForCalendar(intent.title, intent.details)) {
      const task = assistantTasks.create({
        message_id: inboundMessageId,
        source_contact: from,
        title: summarizeTaskTitle(intent.title),
        details: intent.details ?? intent.title,
        primary_context: intent.primaryContext ?? "personal",
        status: "scheduled",
        due_at: intent.startsAt,
        scheduled_for: intent.startsAt,
        calendar_event_id: created.id,
      });
      linkedTaskId = task.id;
    }

    assistantMessages.update(inboundMessageId, {
      status: providerResult.status === "failed" ? "failed" : "processed",
      intent: "calendar",
      metadata_json: JSON.stringify({
        calendarEventId: created.id,
        linkedTaskId,
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
        linkedTaskId,
        startsAt: intent.startsAt,
        syncStatus: providerResult.status,
      },
      source: "assistant",
    });

    const whenLabel = intent.isAllDay
      ? formatDate(intent.startsAt, this.config.timeZone)
      : formatDateTime(intent.startsAt, this.config.timeZone);
    const reply = buildCalendarReply(intent.title, whenLabel, providerResult.status, linkedTaskId !== null);

    this.recordReply(reply, source, from);
    this.queueMirrorSync("assistant.calendar.created");

    return {
      reply,
      intent: "calendar",
      messageId: inboundMessageId,
      createdRecordId: created.id,
    };
  }

  private async handleQueryIntent(
    inboundMessageId: string,
    source: AssistantMessageSource,
    from: string | null,
    intent: Extract<ParsedAssistantIntent, { kind: "query" }>
  ): Promise<AssistantProcessResult> {
    const generatedAt = this.now().toISOString();

    if (intent.queryType === "agenda") {
      const agenda = this.getAgenda(intent.primaryContext ?? undefined);
      const reply = buildAgendaSummary(agenda);
      const attachment = {
        name: "assistant-agenda.md",
        content: renderAgendaMarkdown(agenda),
      };

      assistantMessages.update(inboundMessageId, {
        status: "processed",
        intent: "query",
        metadata_json: JSON.stringify({
          queryType: "agenda",
          context: intent.primaryContext ?? null,
        }),
      });
      this.recordReply(reply, source, from);
      return {
        reply,
        intent: "query",
        messageId: inboundMessageId,
        attachment,
      };
    }

    if (intent.queryType === "inbox") {
      const inbox = this.listInbox(25, intent.primaryContext ?? undefined);
      const reply = inbox.length === 0
        ? "Your assistant inbox is clear."
        : `Your inbox has ${inbox.length} item${inbox.length === 1 ? "" : "s"} waiting for triage.`;
      const attachment = {
        name: "assistant-inbox.md",
        content: renderInboxMarkdown(inbox, this.config.timeZone, generatedAt),
      };

      assistantMessages.update(inboundMessageId, {
        status: "processed",
        intent: "query",
        metadata_json: JSON.stringify({
          queryType: "inbox",
          context: intent.primaryContext ?? null,
        }),
      });
      this.recordReply(reply, source, from);
      return {
        reply,
        intent: "query",
        messageId: inboundMessageId,
        attachment,
      };
    }

    const results = this.search(intent.query, {
      context: intent.primaryContext ?? undefined,
      limit: 20,
    });
    const reply = results.length === 0
      ? `I couldn't find anything matching "${intent.query}".`
      : `I found ${results.length} result${results.length === 1 ? "" : "s"} for "${intent.query}".`;
    const attachment = {
      name: "assistant-search.md",
      content: renderSearchMarkdown(intent.query, results, this.config.timeZone, generatedAt),
    };

    assistantMessages.update(inboundMessageId, {
      status: "processed",
      intent: "query",
      metadata_json: JSON.stringify({
        queryType: "search",
        query: intent.query,
        context: intent.primaryContext ?? null,
      }),
    });
    this.recordReply(reply, source, from);
    return {
      reply,
      intent: "query",
      messageId: inboundMessageId,
      attachment,
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

  private toTaskSnapshot(task: {
    id: string;
    title: string;
    details: string;
    primary_context: string;
    status: string;
    due_at: string | null;
    scheduled_for: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
    note_id: string | null;
    reminder_id: string | null;
    calendar_event_id: string | null;
  }): AssistantTaskSnapshot {
    return {
      id: task.id,
      title: task.title,
      details: task.details,
      primaryContext: normalizeStoredContext(task.primary_context),
      status: normalizeTaskStatus(task.status),
      dueAt: task.due_at,
      scheduledFor: task.scheduled_for,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
      noteId: task.note_id,
      reminderId: task.reminder_id,
      calendarEventId: task.calendar_event_id,
    };
  }

  private toCalendarSnapshot(event: {
    id: string;
    message_id: string | null;
    title: string;
    starts_at: string;
    ends_at: string | null;
    timezone: string;
    location: string | null;
    sync_status: string;
  }): AssistantCalendarSnapshot & { metadata?: Record<string, unknown> } {
    const metadata = parseJsonRecord(assistantMessages.getById(event.message_id ?? "")?.metadata_json ?? null);
    return {
      id: event.id,
      title: event.title,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      timeZone: event.timezone,
      location: event.location,
      syncStatus: event.sync_status,
      metadata,
    };
  }

  private buildAgendaNextAction(input: {
    overdueTasks: AssistantTaskSnapshot[];
    dueTodayTasks: AssistantTaskSnapshot[];
    openTasks: AssistantTaskSnapshot[];
    scheduledTasks: AssistantTaskSnapshot[];
    inboxTasks: AssistantTaskSnapshot[];
    upcomingCalendar: AssistantCalendarSnapshot[];
    activeWorkstreams: Array<{ name: string; projectId: string }>;
  }): string {
    if (input.overdueTasks.length > 0) {
      return `Start with overdue task "${input.overdueTasks[0].title}" and clear the rest of the backlog.`;
    }

    if (input.dueTodayTasks.length > 0) {
      return `Handle today's priority "${input.dueTodayTasks[0].title}" first.`;
    }

    if (input.inboxTasks.length > 0) {
      return `Triage inbox item "${input.inboxTasks[0].title}" so it becomes scheduled work or a completed decision.`;
    }

    if (input.openTasks.length > 0) {
      return `Resume open task "${input.openTasks[0].title}".`;
    }

    if (input.upcomingCalendar.length > 0) {
      return `Prepare for "${input.upcomingCalendar[0].title}" next.`;
    }

    if (input.activeWorkstreams.length > 0) {
      return `Resume the ${input.activeWorkstreams[0].projectId} workstream "${input.activeWorkstreams[0].name}".`;
    }

    return "No urgent items are queued. Capture new tasks or review planning notes.";
  }

  private resolveModel(
    feature: AssistantModelFeature,
    scope?: { source?: AssistantMessageSource; channelId?: string | null; requestedProfile?: AssistantModelProfileName | null }
  ): string {
    const requestedProfile = scope?.requestedProfile ?? null;
    const profile = requestedProfile ?? this.resolveProfile(feature, scope);
    return this.config.modelRouting.profiles[profile];
  }

  private resolveProfile(
    feature: AssistantModelFeature,
    scope?: { source?: AssistantMessageSource; channelId?: string | null }
  ): AssistantModelProfileName {
    if (scope?.source === "discord" && scope.channelId) {
      const channelOverride = assistantSettings.get("discord-channel", scope.channelId, feature);
      if (channelOverride) {
        return channelOverride.profile as AssistantModelProfileName;
      }
    }

    const globalOverride = assistantSettings.get("global", "global", feature);
    if (globalOverride) {
      return globalOverride.profile as AssistantModelProfileName;
    }

    return this.config.modelRouting.defaults[feature];
  }

  private extractRequestedProfile(text: string): AssistantModelProfileName | null {
    if (!this.config.modelRouting.allowMessagePrefixes) {
      return null;
    }

    const match = text.trim().match(/^\[(cheap|default|deep)\]\s*/i);
    if (!match) {
      return null;
    }

    return match[1].toLowerCase() as AssistantModelProfileName;
  }

  private stripModelPrefix(text: string): string {
    return text.replace(/^\[(cheap|default|deep)\]\s*/i, "");
  }

  private readChannelId(metadata: Record<string, unknown> | undefined): string | null {
    return typeof metadata?.channelId === "string" ? metadata.channelId : null;
  }

  private queueMirrorSync(reason: string): void {
    this.mirror?.queueSync(reason);
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
    context: AssistantPrimaryContext;
  }
): string {
  if (!params.isWorkNote) {
    return `Saved ${params.context} note: "${title}"`;
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

function buildTaskReply(
  title: string,
  status: string,
  context: string,
  dueAt: string | null,
  timeZone: string
): string {
  const dueSuffix = dueAt ? ` due ${formatDateTime(dueAt, timeZone)}` : "";
  return `Captured ${context} task: "${title}" [${status}]${dueSuffix}.`;
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

function buildCalendarReply(
  title: string,
  whenLabel: string,
  status: "synced" | "pending-config" | "failed",
  linkedTask: boolean
): string {
  const taskSuffix = linkedTask ? " I also created a linked task for it." : "";
  if (status === "synced") {
    return `Calendar event created: "${title}" on ${whenLabel}.${taskSuffix}`.trim();
  }
  if (status === "pending-config") {
    return `Captured "${title}" for ${whenLabel}, but calendar sync still needs provider setup.${taskSuffix}`.trim();
  }
  return `I saved "${title}" for ${whenLabel}, but the calendar provider reported an error.${taskSuffix}`.trim();
}

function parseEnvList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
}

function matchesSearch(values: string[], query: string): boolean {
  return values.some((value) => normalizeAssistantText(value).toLowerCase().includes(query));
}

function dedupeSearchResults(results: AssistantSearchResult[]): AssistantSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.type}:${result.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isSameLocalDay(value: string, referenceTime: Date, timeZone: string): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date(value)) === formatter.format(referenceTime);
}

function shouldCreateTaskForCalendar(title: string, details: string | null): boolean {
  const normalized = normalizeAssistantText(`${title} ${details ?? ""}`).toLowerCase();
  return /\b(prepare|submit|bring|follow up|review|finish|send|draft|file|practice)\b/.test(normalized);
}

function summarizeTaskTitle(value: string): string {
  const normalized = normalizeAssistantText(value);
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69).trimEnd()}...`;
}

function normalizeTaskStatus(value: string): "inbox" | "open" | "scheduled" | "done" | "archived" {
  switch (value) {
    case "open":
    case "scheduled":
    case "done":
    case "archived":
      return value;
    case "inbox":
    default:
      return "inbox";
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
