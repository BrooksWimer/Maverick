import { createLogger } from "../logger.js";
import type { ExecutionBackend } from "../config/index.js";
import type { ProjectConfig } from "../config/index.js";
import { createAdapter } from "../codex/index.js";
import type { ExecutionBackendAdapter, ExecutionInputItem, ExecutionThread } from "../codex/index.js";
import type {
  AssistantAttachment,
  AssistantInterpreter,
  ParsedAssistantIntent,
  WorkNotesConfig,
} from "./types.js";

const log = createLogger("assistant:agent");

type AgentEnvelope = {
  intent?: string;
  confidence?: number;
  note?: {
    title?: string;
    content?: string;
    context?: "work" | "personal" | "home" | "errands" | "health" | "planning";
    noteKind?: "general" | "project" | "study" | "acceptance-criteria";
    projectName?: string | null;
    smartGoalIds?: string[];
  } | null;
  task?: {
    title?: string;
    details?: string;
    primaryContext?: "work" | "personal" | "home" | "errands" | "health" | "planning";
    status?: "inbox" | "open" | "scheduled";
    dueAtIso?: string | null;
    scheduledForIso?: string | null;
  } | null;
  reminder?: {
    body?: string;
    remindAtIso?: string;
    primaryContext?: "work" | "personal" | "home" | "errands" | "health" | "planning";
  } | null;
  calendar?: {
    title?: string;
    startsAtIso?: string;
    endsAtIso?: string | null;
    isAllDay?: boolean;
    recurrenceRule?: string | null;
    details?: string | null;
    location?: string | null;
    primaryContext?: "work" | "personal" | "home" | "errands" | "health" | "planning";
  } | null;
  query?: {
    queryType?: "agenda" | "inbox" | "search";
    query?: string;
    primaryContext?: "work" | "personal" | "home" | "errands" | "health" | "planning" | null;
  } | null;
  clarification?: {
    message?: string;
  } | null;
};

export class CodexAssistantInterpreter implements AssistantInterpreter {
  private readonly adapter: ExecutionBackendAdapter;
  private initializePromise: Promise<void> | null = null;
  private threadPromise: Promise<ExecutionThread> | null = null;

  constructor(
    private readonly project: ProjectConfig,
    backend: ExecutionBackend,
    private readonly workNotes: WorkNotesConfig | null = null
  ) {
    this.adapter = createAdapter(backend);
  }

  async interpret(input: {
    text: string;
    now: Date;
    timeZone: string;
    attachments?: AssistantAttachment[];
    model?: string;
  }): Promise<ParsedAssistantIntent | null> {
    const thread = await this.ensureThread();
    const prompt = buildInterpretationPrompt(
      input.text,
      input.now,
      input.timeZone,
      input.attachments ?? [],
      this.workNotes
    );
    const result = await this.adapter.startTurn({
      threadId: thread.id,
      cwd: this.project.repoPath,
      instruction: prompt,
      inputItems: buildInterpreterInputItems(prompt, input.attachments ?? []),
      model: input.model,
    });

    if (result.status !== "completed") {
      return null;
    }

    const envelope = parseAgentEnvelope(result.output);
    if (!envelope) {
      log.warn({ output: result.output.slice(0, 300) }, "Assistant agent returned unparsable output");
      return null;
    }

    return toParsedIntent(envelope);
  }

  async shutdown(): Promise<void> {
    await this.adapter.shutdown();
  }

  private async ensureThread(): Promise<ExecutionThread> {
    if (!this.threadPromise) {
      this.threadPromise = (async () => {
        if (!this.initializePromise) {
          this.initializePromise = this.adapter.initialize();
        }
        await this.initializePromise;
        return this.adapter.createThread(this.project.repoPath);
      })();
    }

    return this.threadPromise;
  }
}

function buildInterpretationPrompt(
  text: string,
  now: Date,
  timeZone: string,
  attachments: AssistantAttachment[],
  workNotes: WorkNotesConfig | null
): string {
  const attachmentSummaries = attachments.length > 0
    ? [
        "Attachments:",
        ...attachments.map((attachment, index) =>
          `- ${index + 1}. ${attachment.name ?? "attachment"} (${attachment.contentType ?? "unknown"})`
        ),
      ]
    : ["Attachments: none"];

  const workNoteGuidance = workNotes
    ? [
        "For notes, distinguish between generic notes and work notes.",
        "If a note is work-related, return \"context\":\"work\" and classify it into one of:",
        "- \"general\": a general work-progress or job note",
        "- \"project\": a note tied to a named project or ticket",
        "- \"study\": reading, study, or active learning for work",
        "- \"acceptance-criteria\": screenshots or notes about ticket requirements or acceptance criteria",
        "When a work note clearly belongs to a named project or ticket, set projectName.",
        "When a work note supports one of these smart goals, include the matching ids in smartGoalIds:",
        ...workNotes.smartGoals.map((goal) => `- ${goal.id}: ${goal.description}`),
      ]
    : [];

  return [
    "You are Maverick's personal assistant interpreter.",
    "Understand the user's message and return one JSON object only.",
    "Do not use tools. Do not inspect files. Do not ask for permission. Do not wrap the JSON in markdown fences.",
    `Current time: ${now.toISOString()}`,
    `User timezone: ${timeZone}`,
    "Supported intents:",
    '- "note": save a note or memory',
    '- "task": create a task with one primary context and a status of inbox, open, or scheduled',
    '- "reminder": schedule a reminder at a specific future ISO timestamp',
    '- "calendar": create a calendar item with ISO timestamps and an optional Google-style RRULE recurrenceRule when the user asks for a repeating event',
    '- "query": one of agenda, inbox, or search',
    '- "clarification": ask a concise question if required information is missing',
    "Primary contexts: work, personal, home, errands, health, planning.",
    "Only use the query intent when the user is clearly asking Maverick to show agenda/inbox/search information, not when they are capturing something.",
    ...workNoteGuidance,
    "Interpret natural language flexibly, including casual wording and implied tasks.",
    "Return shape:",
    "{" +
      "\"intent\":\"note|task|reminder|calendar|query|clarification\"," +
      "\"confidence\":0.0," +
      "\"note\":{\"title\":\"...\",\"content\":\"...\",\"context\":\"work|personal|home|errands|health|planning\",\"noteKind\":\"general|project|study|acceptance-criteria\",\"projectName\":\"...\",\"smartGoalIds\":[\"...\"]}|null," +
      "\"task\":{\"title\":\"...\",\"details\":\"...\",\"primaryContext\":\"work|personal|home|errands|health|planning\",\"status\":\"inbox|open|scheduled\",\"dueAtIso\":\"...\",\"scheduledForIso\":\"...\"}|null," +
      "\"reminder\":{\"body\":\"...\",\"remindAtIso\":\"...\",\"primaryContext\":\"work|personal|home|errands|health|planning\"}|null," +
      "\"calendar\":{\"title\":\"...\",\"startsAtIso\":\"...\",\"endsAtIso\":\"...\",\"isAllDay\":false,\"recurrenceRule\":\"RRULE:FREQ=DAILY|RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR|RRULE:FREQ=WEEKLY;BYDAY=MO,...\",\"details\":\"...\",\"location\":null,\"primaryContext\":\"work|personal|home|errands|health|planning\"}|null," +
      "\"query\":{\"queryType\":\"agenda|inbox|search\",\"query\":\"...\",\"primaryContext\":\"work|personal|home|errands|health|planning\"}|null," +
      "\"clarification\":{\"message\":\"...\"}|null" +
    "}",
    ...attachmentSummaries,
    `User message: ${text}`,
  ].join("\n");
}

function buildInterpreterInputItems(prompt: string, attachments: AssistantAttachment[]) {
  const items: ExecutionInputItem[] = [{ type: "text", text: prompt }];

  for (const attachment of attachments.slice(0, 4)) {
    const sourceUrl = attachment.url ?? attachment.proxyUrl ?? null;
    if (!sourceUrl || !(attachment.contentType ?? "").startsWith("image/")) {
      continue;
    }

    items.push({
      type: "image",
      imageUrl: sourceUrl,
    });
  }

  return items;
}

function parseAgentEnvelope(output: string): AgentEnvelope | null {
  const trimmed = output.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim(),
  ];

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as AgentEnvelope;
      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function toParsedIntent(envelope: AgentEnvelope): ParsedAssistantIntent | null {
  const confidence = typeof envelope.confidence === "number" ? envelope.confidence : 0.7;

  switch (envelope.intent) {
    case "note":
      if (!envelope.note?.content) {
        return null;
      }
      return {
        kind: "note",
        title: envelope.note.title?.trim() || envelope.note.content.trim().slice(0, 72),
        content: envelope.note.content.trim(),
        confidence,
        context: normalizeContext(envelope.note.context),
        noteKind: envelope.note.noteKind,
        projectName: envelope.note.projectName ?? null,
        smartGoalIds: Array.isArray(envelope.note.smartGoalIds)
          ? envelope.note.smartGoalIds.filter((value): value is string => typeof value === "string")
          : [],
      };
    case "task":
      if (!envelope.task?.details) {
        return null;
      }
      return {
        kind: "task",
        title: envelope.task.title?.trim() || envelope.task.details.trim().slice(0, 72),
        details: envelope.task.details.trim(),
        primaryContext: normalizeContext(envelope.task.primaryContext),
        status: normalizeTaskStatus(envelope.task.status),
        dueAt: envelope.task.dueAtIso ?? null,
        scheduledFor: envelope.task.scheduledForIso ?? null,
        confidence,
      };
    case "reminder":
      if (!envelope.reminder?.body || !envelope.reminder?.remindAtIso) {
        return null;
      }
      return {
        kind: "reminder",
        body: envelope.reminder.body.trim(),
        remindAt: envelope.reminder.remindAtIso,
        parsedFrom: "agent",
        confidence,
        primaryContext: normalizeContext(envelope.reminder.primaryContext),
      };
    case "calendar":
      if (!envelope.calendar?.title || !envelope.calendar?.startsAtIso) {
        return null;
      }
      return {
        kind: "calendar",
        title: envelope.calendar.title.trim(),
        startsAt: envelope.calendar.startsAtIso,
        endsAt: envelope.calendar.endsAtIso ?? null,
        isAllDay: Boolean(envelope.calendar.isAllDay),
        recurrenceRule: envelope.calendar.recurrenceRule ?? null,
        parsedFrom: "agent",
        details: envelope.calendar.details ?? null,
        location: envelope.calendar.location ?? null,
        confidence,
        primaryContext: normalizeContext(envelope.calendar.primaryContext),
      };
    case "query":
      if (!envelope.query?.queryType) {
        return null;
      }
      return {
        kind: "query",
        queryType: envelope.query.queryType,
        query: envelope.query.query?.trim() || envelope.query.queryType,
        primaryContext: envelope.query.primaryContext ? normalizeContext(envelope.query.primaryContext) : null,
        confidence,
      };
    case "clarification":
      return {
        kind: "clarification",
        message:
          envelope.clarification?.message?.trim() ||
          "I need a bit more detail before I can act on that.",
        confidence,
      };
    default:
      return null;
  }
}

function normalizeContext(
  context: AgentEnvelope["note"] extends { context?: infer T } ? T : string | undefined
) {
  switch (context) {
    case "work":
    case "home":
    case "errands":
    case "health":
    case "planning":
      return context;
    case "personal":
    default:
      return "personal";
  }
}

function normalizeTaskStatus(value: string | undefined): "inbox" | "open" | "scheduled" {
  switch (value) {
    case "open":
    case "scheduled":
      return value;
    case "inbox":
    default:
      return "inbox";
  }
}
