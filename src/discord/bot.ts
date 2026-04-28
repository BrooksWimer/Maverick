import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  InteractionEditReplyOptions,
  Message,
  MessageCreateOptions,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type RESTPostAPIApplicationCommandsJSONBody,
  type TextBasedChannel,
} from "discord.js";
import { createLogger } from "../logger.js";
import { eventBus } from "../orchestrator/event-bus.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { LaneLifecycleResult } from "../orchestrator/orchestrator.js";
import type { AssistantService } from "../assistant/index.js";
import type { DailyBriefService } from "../daily-brief/index.js";
import type { ApprovalRow, DiscordThreadBindingRow, WorkstreamRow } from "../state/index.js";
import type { DiscordRoute, EpicBranchConfig, OrchestratorConfig, ProjectConfig } from "../config/schema.js";
import { workstreamLaneForEpic } from "../projects/epics.js";
import type { AssistantAttachment } from "../assistant/types.js";
import { buildAgendaSummary, renderAgendaMarkdown, renderInboxMarkdown, renderSearchMarkdown } from "../assistant/render.js";
import { renderWorkstreamStatusSnapshot } from "../orchestrator/status.js";
import { renderMarkdownDocument } from "../markdown/presentation.js";
import type { PendingPlanningDecision } from "../agents/types.js";
import { renderPlanningSummary } from "../agents/planning-support.js";
import { getRuntimeInstanceId } from "../runtime/identity.js";

const log = createLogger("discord");

type DiscordBotOptions = {
  token: string;
  applicationId: string;
  guildId?: string;
};

const APPROVAL_PREFIX = "approval";
const PLANNING_ANSWER_PREFIX = "planning-answer";
const PLANNING_ANSWER_MODAL_PREFIX = "planning-answer-modal";
const PLANNING_QUESTIONS_PER_MODAL = 5;

type SendableChannel = TextBasedChannel & {
  send: (options: string | MessageCreateOptions) => Promise<unknown>;
};

const DISCORD_STATUS_PREVIEW_LIMIT = 1500;
const DISCORD_RENDERED_MESSAGE_LIMIT = 1900;

export type WorkstreamChannelBinding = {
  channelId: string;
  threadId?: string;
  parentChannelId?: string;
};

export type ParsedEpicChoice = {
  projectId: string;
  epicId: string;
  kind: "epic" | "lane";
};

type ResolvedEpic = {
  id: string;
  branch: string;
  lane: string;
  source: "route" | "explicit" | "default";
};

type ResolvedThreadContext = {
  projectId: string;
  route: DiscordRoute | null;
  parentChannelId: string | null;
  threadId: string | null;
  lane: string | null;
  baseBranch: string | null;
  epicId: string | null;
  assistantEnabled: boolean;
  ownerInstanceId: string | null;
  source: "route" | "thread-binding" | "thread-title";
  binding: DiscordThreadBindingRow | null;
};

type WorkSmartGoalChoice = "none" | "business-context" | "engineering-learning" | "both";

type AsyncWorkstreamCommand = "plan" | "answer-plan" | "dispatch" | "review" | "verify" | "finish";

function isDiscordApiError(error: unknown, code?: number): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown };
  if (typeof candidate.code !== "number") {
    return false;
  }

  return code === undefined ? true : candidate.code === code;
}

function truncate(text: string, max = 1800): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 3)}...`;
}

export function shouldAttachReplyPreview(
  headerLines: string[],
  previewBody: string,
  previewLimit = 1500
): boolean {
  const inlinePreview = truncate(previewBody, previewLimit);
  const inlineContent = [...headerLines, inlinePreview].filter(Boolean).join("\n");
  return inlinePreview !== previewBody || inlineContent.length > 1900;
}

export function splitDiscordMessageContent(
  content: string,
  maxLength = DISCORD_RENDERED_MESSAGE_LIMIT
): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [""];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const breakIndex = pickChunkBreakIndex(window, maxLength);
    const chunk = remaining.slice(0, breakIndex).trimEnd();

    chunks.push(chunk || remaining.slice(0, maxLength));
    remaining = remaining.slice(Math.max(breakIndex, 1)).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function pickChunkBreakIndex(window: string, maxLength: number): number {
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak >= Math.floor(maxLength * 0.5)) {
    return paragraphBreak;
  }

  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak >= Math.floor(maxLength * 0.5)) {
    return lineBreak;
  }

  const wordBreak = window.lastIndexOf(" ");
  if (wordBreak >= Math.floor(maxLength * 0.5)) {
    return wordBreak;
  }

  return maxLength;
}

function mergeRenderedReply(headerLines: string[], body: string): string {
  const trimmedBody = body.trim();
  const trimmedHeaders = headerLines.map((line) => line.trim()).filter(Boolean);

  if (!trimmedBody) {
    return trimmedHeaders.join("\n\n");
  }

  if (trimmedBody.startsWith("# ")) {
    return trimmedBody;
  }

  return [...trimmedHeaders, trimmedBody].filter(Boolean).join("\n\n");
}

function renderPlanningQuestionLines(questions: PendingPlanningDecision[]): string[] {
  if (questions.length === 0) {
    return [];
  }

  return questions.flatMap((question, index) => [
    `${index + 1}. \`${question.id}\` - ${question.question}`,
    `Why it matters: ${question.whyItMatters}`,
    question.options && question.options.length > 0 ? `Options: ${question.options.join(" | ")}` : "",
    "",
  ]).filter((line) => line.length > 0);
}

function planningQuestionPageCount(questions: PendingPlanningDecision[]): number {
  return Math.ceil(questions.length / PLANNING_QUESTIONS_PER_MODAL);
}

function buildPlanningAnswerButtonRows(
  workstreamId: string,
  questions: PendingPlanningDecision[],
): ActionRowBuilder<ButtonBuilder>[] {
  const pageCount = planningQuestionPageCount(questions);
  if (pageCount === 0) {
    return [];
  }

  const buttons = Array.from({ length: pageCount }, (_, pageIndex) => {
    const start = pageIndex * PLANNING_QUESTIONS_PER_MODAL + 1;
    const end = Math.min(start + PLANNING_QUESTIONS_PER_MODAL - 1, questions.length);
    return new ButtonBuilder()
      .setCustomId(`${PLANNING_ANSWER_PREFIX}:page:${workstreamId}:${pageIndex}`)
      .setLabel(pageCount === 1 ? "Answer Questions" : `Answer ${start}-${end}`)
      .setStyle(ButtonStyle.Primary);
  });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons.slice(index, index + 5)));
  }

  return rows;
}

export function buildAttachedTextReply(params: {
  headerLines: string[];
  body: string;
  previewLimit?: number;
  attachmentName: string;
  attachmentNotice: string;
}): InteractionEditReplyOptions {
  return {
    content: mergeRenderedReply(params.headerLines, params.body),
  };
}

export function shouldPostPlanGeneratedMessage(event: { needsAnswers: boolean }): boolean {
  return !event.needsAnswers;
}

function buildPlanningQuestionsNotificationMessage(params: {
  workstreamName: string;
  instruction: string;
  renderedPlan: string;
  workstreamId?: string;
  questions?: PendingPlanningDecision[];
}): MessageCreateOptions {
  const questions = params.questions ?? [];
  const components =
    params.workstreamId && questions.length > 0
      ? buildPlanningAnswerButtonRows(params.workstreamId, questions)
      : undefined;
  const fullBody = renderMarkdownDocument({
    title: `Planning Questions - ${params.workstreamName}`,
    summary: ["Planning is waiting on operator input."],
    facts: [{ label: "Instruction", value: truncate(params.instruction, 500) }],
    callouts: [{
      label: questions.length > 0 ? "Answer Flow" : "Reply Format",
      body: questions.length > 0
        ? "Use the buttons below for guided input, or respond with `/workstream answer-plan` using one line per answer: `question-id: your answer`."
        : "Respond with `/workstream answer-plan` using one line per answer: `question-id: your answer`.",
      tone: "warning",
    }],
    sections: [
      questions.length > 0 ? { title: "Questions", lines: renderPlanningQuestionLines(questions) } : null,
      { title: "Details", lines: params.renderedPlan.split(/\r?\n/).map((line) => line || " ") },
    ].filter((section): section is { title: string; lines: string[] } => section !== null),
  });
  return { content: fullBody, components };
}

function buildPlanGeneratedNotificationMessage(params: {
  workstreamName: string;
  instruction: string;
  renderedPlan: string;
  finalExecutionPrompt: string | null;
}): MessageCreateOptions {
  const fullBody = renderMarkdownDocument({
    title: `Planning Ready - ${params.workstreamName}`,
    summary: [
      params.finalExecutionPrompt
        ? "Planning produced a final execution prompt."
        : "A structured plan was stored, but no final execution prompt is ready yet.",
    ],
    facts: [{ label: "Instruction", value: truncate(params.instruction, 500) }],
    callouts: [{
      label: "Next Action",
      body: params.finalExecutionPrompt
        ? "Dispatch with the same instruction to reuse the stored final Codex execution prompt."
        : "Review the stored plan and refine the execution prompt before dispatching.",
      tone: params.finalExecutionPrompt ? "success" : "warning",
    }],
    sections: [{ title: "Details", lines: params.renderedPlan.split(/\r?\n/).map((line) => line || " ") }],
  });
  return { content: fullBody };
}

function buildFormattedPlanningSummaryMessage(params: {
  workstreamName: string;
  instruction: string;
  formattedMarkdown: string;
}): MessageCreateOptions {
  const trimmedMarkdown = params.formattedMarkdown.trim();
  const parts = [
    `# Planning Summary - ${params.workstreamName}`,
    `Instruction: ${truncate(params.instruction, 500)}`,
    trimmedMarkdown,
  ].filter(Boolean);

  return {
    content: parts.join("\n\n"),
  };
}

export function buildPlanNotificationMessages(params: {
  workstreamId?: string;
  workstreamName: string;
  instruction: string;
  renderedPlan: string;
  formattedMarkdown: string;
  finalExecutionPrompt: string | null;
  needsAnswers: boolean;
  questions?: PendingPlanningDecision[];
}): MessageCreateOptions[] {
  const questionIds = new Set((params.questions ?? []).map((question) => question.id));
  const formattedMarkdownIsCurrent =
    questionIds.size === 0 ||
    [...questionIds].every((questionId) => params.formattedMarkdown.includes(questionId));
  const messages: MessageCreateOptions[] = [
    params.needsAnswers
      ? buildPlanningQuestionsNotificationMessage({
        workstreamName: params.workstreamName,
        instruction: params.instruction,
        renderedPlan: params.renderedPlan,
        workstreamId: params.workstreamId,
        questions: params.questions,
      })
      : buildPlanGeneratedNotificationMessage({
        workstreamName: params.workstreamName,
        instruction: params.instruction,
        renderedPlan: params.renderedPlan,
        finalExecutionPrompt: params.finalExecutionPrompt,
      }),
  ];

  const trimmedRenderedPlan = params.renderedPlan.trim();
  const trimmedFormattedMarkdown = params.formattedMarkdown.trim();
  if (trimmedFormattedMarkdown && trimmedFormattedMarkdown !== trimmedRenderedPlan && formattedMarkdownIsCurrent) {
    messages.push(
      buildFormattedPlanningSummaryMessage({
        workstreamName: params.workstreamName,
        instruction: params.instruction,
        formattedMarkdown: trimmedFormattedMarkdown,
      })
    );
  }

  return messages;
}

export function parsePlanningAnswerInput(text: string): {
  answers: Record<string, string>;
  invalidLines: string[];
} {
  const answers: Record<string, string> = {};
  const invalidLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.search(/[:=]/);
    if (separatorIndex <= 0) {
      invalidLines.push(line);
      continue;
    }

    const questionId = line.slice(0, separatorIndex).trim();
    const answer = line.slice(separatorIndex + 1).trim();
    if (!questionId || !answer) {
      invalidLines.push(line);
      continue;
    }

    answers[questionId] = answer;
  }

  return { answers, invalidLines };
}

export function persistedEpicIdForResolvedEpic(
  epic: { id: string; source: "route" | "explicit" | "default" } | null
): string | undefined {
  if (!epic || epic.source === "default" || epic.id === "default") {
    return undefined;
  }

  return epic.id;
}

export function resolveWorkstreamChannelBindingForIds(params: {
  interactionChannelId: string;
  parentChannelId?: string | null;
  routeChannelId?: string | null;
}): WorkstreamChannelBinding {
  if (params.parentChannelId && params.routeChannelId === params.parentChannelId) {
    return {
      channelId: params.interactionChannelId,
      threadId: params.interactionChannelId,
      parentChannelId: params.parentChannelId,
    };
  }

  return {
    channelId: params.interactionChannelId,
  };
}

export function notificationChannelCandidateIds(
  workstream: Pick<WorkstreamRow, "discord_thread_id" | "discord_channel_id" | "project_id">,
  routeChannelId?: string | null,
  defaultChannelId?: string | null,
): string[] {
  return [
    workstream.discord_thread_id,
    workstream.discord_channel_id,
    routeChannelId,
    defaultChannelId,
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function buildWorkstreamEpicChoices(config: Pick<OrchestratorConfig, "projects">) {
  return config.projects.flatMap((project) => [
    ...project.epicBranches.map((epic) => ({
      name: `${project.name}: ${epic.id}`,
      value: `${project.id}:epic:${epic.id}`,
    })),
    ...project.defaultLanes.map((lane) => ({
      name: `${project.name}: ${lane.id}`,
      value: `${project.id}:lane:${lane.id}`,
    })),
  ]);
}

export function parseWorkstreamEpicChoice(rawEpicChoice: string | null): ParsedEpicChoice | null {
  if (!rawEpicChoice) {
    return null;
  }

  const parts = rawEpicChoice.split(":");
  if (parts.length === 2) {
    const [projectId, epicId] = parts;
    if (!projectId || !epicId) {
      throw new Error(`Epic choice must look like "<project>:<epic>", got "${rawEpicChoice}".`);
    }

    return { projectId, epicId, kind: "epic" };
  }

  const [projectId, kind, epicId] = parts;
  if (!projectId || !epicId || (kind !== "epic" && kind !== "lane")) {
    throw new Error(
      `Epic choice must look like "<project>:epic:<epic>" or "<project>:lane:<lane>", got "${rawEpicChoice}".`
    );
  }

  return { projectId, epicId, kind };
}

function routeScore(route: DiscordRoute, purpose: "workstreams" | "notifications" | "approvals" | "logs") {
  if (route.purpose === purpose) {
    return 3;
  }
  if (purpose === "approvals" && route.purpose === "workstreams") {
    return 2;
  }
  if (purpose === "notifications" && route.purpose === "workstreams") {
    return 1;
  }
  return 0;
}

function subcommandBuilder(config: OrchestratorConfig) {
  const projectChoices = config.projects.map((project) => ({
    name: project.name,
    value: project.id,
  }));
  const smartGoalChoices = [
    { name: "None", value: "none" },
    { name: "Business Context", value: "business-context" },
    { name: "Engineering Learning", value: "engineering-learning" },
    { name: "Both Goals", value: "both" },
  ] as const;
  const assistantContextChoices = [
    { name: "Work", value: "work" },
    { name: "Personal", value: "personal" },
    { name: "Home", value: "home" },
    { name: "Errands", value: "errands" },
    { name: "Health", value: "health" },
    { name: "Planning", value: "planning" },
  ] as const;
  const assistantProfileChoices = [
    { name: "Cheap", value: "cheap" },
    { name: "Default", value: "default" },
    { name: "Deep", value: "deep" },
  ] as const;
  const assistantModelFeatureChoices = [
    { name: "Classification", value: "classification" },
    { name: "Query", value: "query" },
    { name: "Summary", value: "summary" },
    { name: "Planning", value: "planning" },
    { name: "Verification", value: "verification" },
    { name: "Review", value: "review" },
  ] as const;
  const addWorkAttachmentOptions = <T extends {
    addAttachmentOption: (builder: (option: any) => any) => T;
  }>(subcommand: T): T =>
    subcommand
      .addAttachmentOption((option) =>
        option.setName("attachment").setDescription("Optional image or file").setRequired(false)
      )
      .addAttachmentOption((option) =>
        option.setName("attachment_2").setDescription("Optional second image or file").setRequired(false)
      )
      .addAttachmentOption((option) =>
        option.setName("attachment_3").setDescription("Optional third image or file").setRequired(false)
      )
      .addAttachmentOption((option) =>
        option.setName("attachment_4").setDescription("Optional fourth image or file").setRequired(false)
      );
  const epicChoices = buildWorkstreamEpicChoices(config);

  const workstream = new SlashCommandBuilder()
    .setName("workstream")
    .setDescription("Manage Maverick workstreams")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Create a new workstream in this channel")
        .addStringOption((option) =>
          option.setName("name").setDescription("Workstream name").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("project")
            .setDescription("Project id")
            .setRequired(false)
            .addChoices(...projectChoices)
        )
        .addStringOption((option) =>
          option.setName("description").setDescription("Short description").setRequired(false)
        )
        .addStringOption((option) => {
          option
            .setName("epic")
            .setDescription("Epic or durable lane to branch from when the route is not already pinned")
            .setRequired(false);
          if (epicChoices.length > 0) {
            option.addChoices(...epicChoices);
          }
          return option;
        })
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show the current workstream or all workstreams in this channel")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("dispatch")
        .setDescription("Start a Codex turn for a workstream")
        .addStringOption((option) =>
          option.setName("instruction").setDescription("Instruction for Codex").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("steer")
        .setDescription("Send additional guidance to the active turn")
        .addStringOption((option) =>
          option.setName("instruction").setDescription("Additional guidance").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("cancel")
        .setDescription("Interrupt the active turn")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("archive")
        .setDescription("Archive a workstream so it no longer counts as active in this channel")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("review")
        .setDescription("Run a structured review")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Review target, e.g. uncommitted, branch-diff, or a commit SHA")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("claude")
            .setDescription("Use Claude as the reviewer instead of the primary backend")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("verify")
        .setDescription("Run Claude verification for the current workstream")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("finish")
        .setDescription("Merge a verified workstream into this thread's durable lane branch")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("plan")
        .setDescription("Generate and store a Claude implementation plan")
        .addStringOption((option) =>
          option
            .setName("instruction")
            .setDescription("High-level instruction for Claude to plan")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("resume")
            .setDescription("Resume the existing planning flow instead of starting a fresh one")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("answer-plan")
        .setDescription("Provide structured answers for a pending planning flow")
        .addStringOption((option) =>
          option
            .setName("answers")
            .setDescription("One answer per line using question-id: answer")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("repost-plan")
        .setDescription("Repost the stored planning output without rerunning Claude")
        .addStringOption((option) =>
          option.setName("workstream").setDescription("Specific workstream id").setRequired(false)
        )
    );

  const project = new SlashCommandBuilder()
    .setName("project")
    .setDescription("Inspect Maverick project status")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show project status")
        .addStringOption((option) =>
          option
            .setName("project")
            .setDescription("Project id")
            .setRequired(false)
            .addChoices(...projectChoices)
        )
    );

  const lane = new SlashCommandBuilder()
    .setName("lane")
    .setDescription("Manage the durable branch for this Discord thread or epic lane")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Show lane promotion readiness")
        .addStringOption((option) =>
          option
            .setName("project")
            .setDescription("Project id")
            .setRequired(false)
            .addChoices(...projectChoices)
        )
        .addStringOption((option) =>
          option.setName("lane").setDescription("Lane id, epic id, or durable branch").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("verify")
        .setDescription("Verify this durable lane branch can promote to production")
        .addStringOption((option) =>
          option
            .setName("project")
            .setDescription("Project id")
            .setRequired(false)
            .addChoices(...projectChoices)
        )
        .addStringOption((option) =>
          option.setName("lane").setDescription("Lane id, epic id, or durable branch").setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("promote")
        .setDescription("Promote this durable lane branch to the production branch")
        .addStringOption((option) =>
          option
            .setName("project")
            .setDescription("Project id")
            .setRequired(false)
            .addChoices(...projectChoices)
        )
        .addStringOption((option) =>
          option.setName("lane").setDescription("Lane id, epic id, or durable branch").setRequired(false)
        )
    );

  const work = new SlashCommandBuilder()
    .setName("work")
    .setDescription("Capture structured work notes")
    .addSubcommand((subcommand) =>
      addWorkAttachmentOptions(subcommand
        .setName("general")
        .setDescription("Save a general work note")
        .addStringOption((option) =>
          option.setName("details").setDescription("The note body or summary").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("title").setDescription("Optional short title").setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("smart_goal")
            .setDescription("Optionally file this note under a smart goal")
            .setRequired(false)
            .addChoices(...smartGoalChoices)
        ))
    )
    .addSubcommand((subcommand) =>
      addWorkAttachmentOptions(subcommand
        .setName("project")
        .setDescription("Save a project-specific work note")
        .addStringOption((option) =>
          option.setName("project").setDescription("Project or ticket name").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("details").setDescription("The note body or summary").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("title").setDescription("Optional short title").setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("smart_goal")
            .setDescription("Optionally file this note under a smart goal")
            .setRequired(false)
            .addChoices(...smartGoalChoices)
        ))
    )
    .addSubcommand((subcommand) =>
      addWorkAttachmentOptions(subcommand
        .setName("acceptance")
        .setDescription("Save ticket acceptance criteria or requirement capture")
        .addStringOption((option) =>
          option.setName("project").setDescription("Project, ticket, or feature name").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("details").setDescription("Short explanation of the capture").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("title").setDescription("Optional short title").setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("smart_goal")
            .setDescription("Override the default smart goal filing")
            .setRequired(false)
            .addChoices(...smartGoalChoices)
        ))
    )
    .addSubcommand((subcommand) =>
      addWorkAttachmentOptions(subcommand
        .setName("study")
        .setDescription("Save a study note for work reading or active learning")
        .addStringOption((option) =>
          option.setName("details").setDescription("What you studied or learned").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("title").setDescription("Optional short title").setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("project").setDescription("Optional related work project").setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("smart_goal")
            .setDescription("Override the default smart goal filing")
            .setRequired(false)
            .addChoices(...smartGoalChoices)
        ))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("recent")
        .setDescription("Show recently captured work notes")
        .addIntegerOption((option) =>
          option.setName("limit").setDescription("How many notes to show").setRequired(false).setMinValue(1).setMaxValue(10)
        )
    );

  const brief = new SlashCommandBuilder()
    .setName("brief")
    .setDescription("Generate Maverick summary briefs")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("daily")
        .setDescription("Generate a preview of today's daily brief")
    );

  const assistant = new SlashCommandBuilder()
    .setName("assistant")
    .setDescription("Manage Maverick Life OS notes, tasks, and model routing")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("agenda")
        .setDescription("Show what needs attention now")
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("Limit to one primary context")
            .setRequired(false)
            .addChoices(...assistantContextChoices)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("inbox")
        .setDescription("Show unresolved actionable items")
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("Limit to one primary context")
            .setRequired(false)
            .addChoices(...assistantContextChoices)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("find")
        .setDescription("Search notes, tasks, reminders, calendar items, and project memory")
        .addStringOption((option) =>
          option.setName("query").setDescription("What to search for").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("Limit to one primary context")
            .setRequired(false)
            .addChoices(...assistantContextChoices)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("done")
        .setDescription("Mark a task complete")
        .addStringOption((option) =>
          option.setName("task").setDescription("Task id").setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("snooze")
        .setDescription("Defer a task or reminder")
        .addStringOption((option) =>
          option.setName("task").setDescription("Task id").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("when")
            .setDescription("A date/time string JavaScript can parse, like 2026-04-25T14:00:00-04:00")
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("retag")
        .setDescription("Correct an item's primary context")
        .addStringOption((option) =>
          option.setName("item").setDescription("Task or note id").setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("context")
            .setDescription("New primary context")
            .setRequired(true)
            .addChoices(...assistantContextChoices)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("models")
        .setDescription("Inspect or override assistant model profiles")
        .addStringOption((option) =>
          option
            .setName("scope")
            .setDescription("Override scope; omit to inspect current effective settings")
            .setRequired(false)
            .addChoices(
              { name: "Channel", value: "discord-channel" },
              { name: "Global", value: "global" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("feature")
            .setDescription("Feature to override")
            .setRequired(false)
            .addChoices(...assistantModelFeatureChoices)
        )
        .addStringOption((option) =>
          option
            .setName("profile")
            .setDescription("Logical model profile")
            .setRequired(false)
            .addChoices(...assistantProfileChoices)
        )
    );

  const maverick = new SlashCommandBuilder()
    .setName("maverick")
    .setDescription("Run Maverick control-plane operations")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("brief")
        .setDescription("Generate and post the nightly Claude brief")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("audit")
        .setDescription("Inspect Maverick git, Discord, and state routing health")
        .addStringOption((option) =>
          option
            .setName("scope")
            .setDescription("Which part of the control plane to inspect")
            .setRequired(false)
            .addChoices(
              { name: "All", value: "all" },
              { name: "Git", value: "git" },
              { name: "Discord", value: "discord" },
              { name: "State", value: "state" },
            )
        )
    );

  return [
    workstream.toJSON(),
    project.toJSON(),
    lane.toJSON(),
    work.toJSON(),
    brief.toJSON(),
    assistant.toJSON(),
    maverick.toJSON(),
  ] satisfies RESTPostAPIApplicationCommandsJSONBody[];
}

export class DiscordBot {
  private readonly client: Client;
  private readonly commands: RESTPostAPIApplicationCommandsJSONBody[];
  private readonly instanceId = getRuntimeInstanceId();
  private readonly planningAnswerDrafts = new Map<string, Record<string, string>>();

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly config: OrchestratorConfig,
    private readonly options: DiscordBotOptions,
    private readonly assistant: AssistantService | null = null,
    private readonly dailyBrief: DailyBriefService | null = null
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    });
    this.commands = subcommandBuilder(config);
    this.assistant?.setReminderDispatcher(async ({ destination, body }) => {
      const channel = await this.fetchTextChannel(destination);
      if (!channel) {
        return {
          provider: "discord",
          status: "failed",
          error: `Configured reminder channel ${destination} is not accessible.`,
        };
      }

      try {
        await channel.send({ content: body });
        return {
          provider: "discord",
          status: "sent",
          providerMessageId: null,
        };
      } catch (error) {
        return {
          provider: "discord",
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    this.dailyBrief?.setDispatcher(async ({
      channelId,
      headline,
      preview,
      markdown,
      trigger,
    }) => {
      const channel = await this.fetchTextChannel(channelId);
      if (!channel) {
        throw new Error(`Daily brief channel ${channelId} is not accessible.`);
      }

      await this.safeSend(channel, {
        content: markdown.trim() || [headline, trigger === "scheduled" ? "Nightly brief delivered." : "Daily brief preview.", preview]
          .filter(Boolean)
          .join("\n\n"),
      });
    });
  }

  async start(): Promise<void> {
    await this.registerCommands();
    this.registerEventBusSubscriptions();

    this.client.once("ready", () => {
      log.info({ user: this.client.user?.tag }, "Discord bot ready");
    });

    this.client.on("interactionCreate", (interaction) => {
      void this.handleInteraction(interaction);
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessageCreate(message);
    });

    await this.client.login(this.options.token);
  }

  async stop(): Promise<void> {
    this.client.removeAllListeners();
    this.client.destroy();
  }

  private async registerCommands(): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(this.options.token);
    const route = this.options.guildId
      ? Routes.applicationGuildCommands(this.options.applicationId, this.options.guildId)
      : Routes.applicationCommands(this.options.applicationId);

    await rest.put(route, { body: this.commands });
    log.info(
      { scope: this.options.guildId ? "guild" : "global", count: this.commands.length },
      "Discord commands registered"
    );
  }

  private registerEventBusSubscriptions(): void {
    eventBus.on("workstream.created", (event) => {
      this.runBackgroundTask("workstream.created", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "notifications");
        if (!channel) {
          log.warn(
            { workstreamId: workstream.id, discordChannelId: workstream.discord_channel_id },
            "No Discord channel available for workstream-created notification"
          );
          return;
        }

        await this.safeSend(channel, {
          content: [
            `Maverick bound this thread to workstream \`${workstream.name}\`.`,
            `Workstream ID: \`${workstream.id}\``,
            `Project: \`${workstream.project_id}\``,
            workstream.epic_id ? `Epic: \`${workstream.epic_id}\`` : null,
            workstream.branch ? `Branch: \`${workstream.branch}\`` : "Branch: shared repository root",
            workstream.cwd ? `Workspace: \`${workstream.cwd}\`` : null,
            workstream.codex_thread_id ? `Codex thread: \`${workstream.codex_thread_id}\`` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      });
    });

    eventBus.on("workstream.finished", (event) => {
      this.runBackgroundTask("workstream.finished", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "notifications");
        if (!channel) {
          return;
        }

        await this.safeSend(channel, {
          content: [
            `Maverick finished \`${workstream.name}\`.`,
            `Workstream: \`${event.workstreamId}\``,
            `Disposable branch: \`${event.workstreamBranch}\``,
            `Durable lane branch: \`${event.durableBranch}\``,
            "The workstream is archived and its history remains inspectable.",
            "Production was not changed. Use `/lane promote` from this lane when you are ready.",
          ].join("\n"),
        });
      });
    });

    eventBus.on("turn.completed", (event) => {
      this.runBackgroundTask("turn.completed", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "notifications");
        if (!channel) {
          log.warn(
            { workstreamId: workstream.id, discordChannelId: workstream.discord_channel_id },
            "No Discord channel available for turn-completed notification"
          );
          return;
        }

        const heading =
          event.status === "completed"
            ? `Maverick completed work in \`${workstream.name}\`.`
            : event.status === "failed"
              ? `Maverick hit a failure in \`${workstream.name}\`.`
              : `Maverick updated \`${workstream.name}\` with status \`${event.status}\`.`;

        await this.safeSend(
          channel,
          this.appendStatusFooter(
            this.buildTurnCompletedMessage(heading, event.turnId, event.summary, event.output),
            workstream.id,
          ),
        );
      });
    });

    eventBus.on("approval.requested", (event) => {
      this.runBackgroundTask("approval.requested", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "approvals");
        if (!channel) {
          log.warn({ workstreamId: event.workstreamId }, "No Discord channel available for approval request");
          return;
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${APPROVAL_PREFIX}:approve:${event.approvalId}`)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`${APPROVAL_PREFIX}:deny:${event.approvalId}`)
            .setLabel("Deny")
            .setStyle(ButtonStyle.Danger)
        );

        await this.safeSend(channel, {
          content: [
            `Approval needed for workstream \`${workstream.name}\``,
            `Tier: \`${event.tier}\``,
            `Type: \`${event.type}\``,
            truncate(event.description, 1200),
          ].join("\n"),
          components: [row],
        });
      });
    });

    eventBus.on("brief.generated", (event) => {
      this.runBackgroundTask("brief.generated", async () => {
        const channel = event.channelId
          ? await this.fetchTextChannel(event.channelId)
          : await this.resolveDefaultChannel();
        if (!channel) {
          log.warn({ channelId: event.channelId }, "No Discord channel available for Claude brief");
          return;
        }

        await this.safeSend(channel, this.buildBriefGeneratedMessage(event.generatedAt, event.summary, event.markdown));
      });
    });

    eventBus.on("review.completed", (event) => {
      this.runBackgroundTask("review.completed", async () => {
        const channel = await this.resolveNotificationChannelFromWorkstreamId(event.workstreamId, "notifications");
        if (!channel) {
          log.warn({ workstreamId: event.workstreamId }, "No Discord channel available for Claude review");
          return;
        }

        await this.safeSend(
          channel,
          this.appendStatusFooter(
            this.buildReviewCompletedMessage(event.workstreamId, event.severity, event.findings),
            event.workstreamId,
          ),
        );
      });
    });

    eventBus.on("verification.completed", (event) => {
      this.runBackgroundTask("verification.completed", async () => {
        const channel = await this.resolveNotificationChannelFromWorkstreamId(event.workstreamId, "notifications");
        if (!channel) {
          log.warn({ workstreamId: event.workstreamId }, "No Discord channel available for Claude verification");
          return;
        }

        await this.safeSend(
          channel,
          this.appendStatusFooter(
            this.buildVerificationCompletedMessage(
              event.workstreamId,
              event.status,
              event.recommendation,
              event.renderedVerification,
            ),
            event.workstreamId,
          ),
        );
      });
    });

    eventBus.on("decision.needed", (event) => {
      this.runBackgroundTask("decision.needed", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "notifications");
        if (!channel) {
          log.warn({ workstreamId: event.workstreamId }, "No Discord channel available for planning questions");
          return;
        }

        for (const message of buildPlanNotificationMessages({
          workstreamId: workstream.id,
          workstreamName: workstream.name,
          instruction: event.instruction,
          renderedPlan: event.renderedPlan,
          formattedMarkdown: event.formattedMarkdown,
          finalExecutionPrompt: null,
          needsAnswers: true,
          questions: event.questions,
        })) {
          await this.safeSend(channel, message);
        }
      });
    });

    eventBus.on("plan.generated", (event) => {
      if (!shouldPostPlanGeneratedMessage(event)) {
        return;
      }

      this.runBackgroundTask("plan.generated", async () => {
        const workstream = this.orchestrator.getWorkstream(event.workstreamId);
        if (!workstream) {
          return;
        }

        const channel = await this.resolveNotificationChannel(workstream, "notifications");
        if (!channel) {
          log.warn({ workstreamId: event.workstreamId }, "No Discord channel available for auto-generated plan");
          return;
        }

        for (const message of buildPlanNotificationMessages({
          workstreamId: workstream.id,
          workstreamName: workstream.name,
          instruction: event.instruction,
          renderedPlan: event.renderedPlan,
          formattedMarkdown: event.formattedMarkdown,
          finalExecutionPrompt: event.finalExecutionPrompt,
          needsAnswers: false,
        })) {
          await this.safeSend(channel, message);
        }
      });
    });

    eventBus.on("error", (event) => {
      this.runBackgroundTask("error", async () => {
        const channel = event.workstreamId
          ? await this.resolveNotificationChannelFromWorkstreamId(event.workstreamId, "notifications")
          : await this.resolveDefaultChannel();

        if (!channel) {
          return;
        }

        await this.safeSend(channel, {
          content: [
            "Maverick hit an error.",
            event.workstreamId ? `Workstream: \`${event.workstreamId}\`` : null,
            event.context ? `Context: ${event.context}` : null,
            `Error: ${truncate(event.error.message, 1200)}`,
          ]
            .filter(Boolean)
            .join("\n"),
        });
      });
    });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleChatCommand(interaction);
        return;
      }

      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        await this.handleModalSubmit(interaction);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, "Discord interaction failed");

      if (interaction.isRepliable()) {
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.followUp({
              content: `Maverick failed: ${truncate(message, 1500)}`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: `Maverick failed: ${truncate(message, 1500)}`,
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch (responseError) {
          log.warn(
            { err: responseError, originalError: message },
            "Failed to send Discord interaction error response"
          );
        }
      }
    }
  }

  private async handleMessageCreate(message: Message): Promise<void> {
    if (!this.assistant?.isEnabled()) {
      return;
    }

    if (message.author.bot || !message.inGuild()) {
      return;
    }

    const threadContext = this.resolveAssistantThreadContext(message);
    const legacyAssistantChannel = this.isLegacyAssistantChannel(message.channelId);
    if (!threadContext && !legacyAssistantChannel) {
      return;
    }

    if (threadContext?.ownerInstanceId && threadContext.ownerInstanceId !== this.instanceId) {
      return;
    }

    const content = this.normalizeAssistantMessageContent(message.content).trim();
    const attachments = this.serializeAttachments(message);
    if (!content && attachments.length === 0) {
      return;
    }

    try {
      const result = await this.assistant.processIncomingMessage({
        source: "discord",
        body: content,
        from: message.author.id,
        replyTarget: message.channelId,
        attachments,
        metadata: {
          channelId: message.channelId,
          guildId: message.guildId,
          messageId: message.id,
          username: message.author.username,
          projectId: threadContext?.projectId ?? null,
          laneId: threadContext?.lane ?? null,
          threadId: threadContext?.threadId ?? null,
          epicId: threadContext?.epicId ?? null,
          ownerInstanceId: threadContext?.ownerInstanceId ?? null,
          routeChannelId: threadContext?.route?.channelId ?? null,
          parentChannelId: threadContext?.parentChannelId ?? null,
        },
      });

      const renderedContent = result.attachment?.content ?? result.reply;
      if (this.config.assistant.discord.replyInThread) {
        await this.replyWithChunks(message, renderedContent, { allowedMentions: { repliedUser: false } });
      } else {
        await this.safeSend(message.channel as SendableChannel, {
          content: renderedContent,
        });
      }
    } catch (error) {
      log.error({ err: error, channelId: message.channelId }, "Assistant message handling failed");
      await this.safeSend(message.channel as SendableChannel, {
        content: "Maverick hit an error while handling that assistant message.",
      });
    }
  }

  private async handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "workstream") {
      await this.handleWorkstreamCommand(interaction);
      return;
    }

    if (interaction.commandName === "project") {
      await this.handleProjectCommand(interaction);
      return;
    }

    if (interaction.commandName === "lane") {
      await this.handleLaneCommand(interaction);
      return;
    }

    if (interaction.commandName === "work") {
      await this.handleWorkCommand(interaction);
      return;
    }

    if (interaction.commandName === "brief") {
      await this.handleBriefCommand(interaction);
      return;
    }

    if (interaction.commandName === "assistant") {
      await this.handleAssistantCommand(interaction);
      return;
    }

    if (interaction.commandName === "maverick") {
      await this.handleMaverickCommand(interaction);
    }
  }

  private async handleWorkstreamCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case "start":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleWorkstreamStart(interaction);
        return;
      case "status":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleWorkstreamStatus(interaction);
        return;
      case "dispatch":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleDispatch(interaction);
        return;
      case "steer":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleSteer(interaction);
        return;
      case "cancel":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleCancel(interaction);
        return;
      case "archive":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleArchive(interaction);
        return;
      case "review":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleReview(interaction);
        return;
      case "verify":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleVerify(interaction);
        return;
      case "finish":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleFinish(interaction);
        return;
      case "plan":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handlePlan(interaction);
        return;
      case "answer-plan":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleAnswerPlan(interaction);
        return;
      case "repost-plan":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleRepostPlan(interaction);
        return;
      default:
        await interaction.reply({
          content: `Unsupported workstream subcommand: ${subcommand}`,
          flags: MessageFlags.Ephemeral,
        });
    }
  }

  private async handleProjectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "status") {
      await interaction.reply({
        content: `Unsupported project subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const providedProjectId = interaction.options.getString("project");
    const route = this.resolveInteractionRoute(interaction);
    const threadContext = this.resolveInteractionThreadContext(interaction);
    const projectId =
      providedProjectId ??
      threadContext?.projectId ??
      route?.projectId ??
      (this.config.projects.length === 1 ? this.config.projects[0]?.id : null);

    if (!projectId) {
      await interaction.editReply("No project could be inferred for this channel. Pass a project explicitly.");
      return;
    }

    const status = this.orchestrator.getProjectStatus(projectId);
    const lines = [
      `Project: \`${status.project.name}\` (\`${status.project.id}\`)`,
      `Repo: ${status.project.repoPath}`,
      status.bootstrap
        ? status.bootstrap.missingFiles.length > 0
          ? `Bootstrap: missing ${status.bootstrap.missingFiles.length} file(s)`
          : status.bootstrap.createdFiles.length > 0
            ? `Bootstrap: installed ${status.bootstrap.createdFiles.length} file(s)`
            : "Bootstrap: already present"
        : "Bootstrap: unavailable",
      `Active workstreams: ${status.activeCount}`,
      `Pending approvals: ${status.pendingApprovals}`,
    ];

    if (status.workstreams.length > 0) {
      lines.push("", "Workstreams:");
      for (const workstream of status.workstreams.slice(0, 10)) {
        lines.push(`- \`${workstream.id}\` ${workstream.name} [${workstream.state}]`);
      }
    }

    await interaction.editReply(lines.join("\n"));
  }

  private async handleLaneCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = this.resolveLaneCommandTarget(interaction);
    if (subcommand === "status" || subcommand === "verify") {
      const result = await this.orchestrator.verifyLane(target.projectId, target.laneId);
      await this.editReplyWithChunks(
        interaction,
        this.renderLaneLifecycleResult(
          subcommand === "status" ? "Lane Status" : "Lane Verification",
          result,
        ),
      );
      return;
    }

    if (subcommand === "promote") {
      const result = await this.orchestrator.promoteLane(target.projectId, target.laneId, interaction.user.id);
      await this.editReplyWithChunks(
        interaction,
        this.renderLaneLifecycleResult("Lane Promotion", result),
      );
      return;
    }

    await interaction.editReply(`Unsupported lane subcommand: ${subcommand}`);
  }

  private async handleWorkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.assistant?.isEnabled()) {
      await interaction.reply({
        content: "The Maverick assistant is not enabled right now.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (subcommand) {
      case "general":
        await this.captureStructuredWorkNote(interaction, {
          noteKind: "general",
          defaultSmartGoalIds: [],
        });
        return;
      case "project":
        await this.captureStructuredWorkNote(interaction, {
          noteKind: "project",
          defaultSmartGoalIds: [],
        });
        return;
      case "acceptance":
        await this.captureStructuredWorkNote(interaction, {
          noteKind: "acceptance-criteria",
          defaultSmartGoalIds: ["business-context"],
        });
        return;
      case "study":
        await this.captureStructuredWorkNote(interaction, {
          noteKind: "study",
          defaultSmartGoalIds: ["engineering-learning"],
        });
        return;
      case "recent":
        await this.handleRecentWorkNotes(interaction);
        return;
      default:
        await interaction.editReply(`Unsupported work subcommand: ${subcommand}`);
    }
  }

  private async handleBriefCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.dailyBrief) {
      await interaction.reply({
        content: "The daily brief service is not configured right now.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "daily") {
      await interaction.reply({
        content: `Unsupported brief subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await this.dailyBrief.generateReport();
    await this.editReplyWithChunks(interaction, report.markdown.trim() || [report.headline, report.preview].join("\n\n"));
  }

  private async handleAssistantCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.assistant?.isEnabled()) {
      await interaction.reply({
        content: "The Maverick assistant is not enabled right now.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (subcommand) {
      case "agenda":
        await this.handleAssistantAgenda(interaction);
        return;
      case "inbox":
        await this.handleAssistantInbox(interaction);
        return;
      case "find":
        await this.handleAssistantFind(interaction);
        return;
      case "done":
        await this.handleAssistantDone(interaction);
        return;
      case "snooze":
        await this.handleAssistantSnooze(interaction);
        return;
      case "retag":
        await this.handleAssistantRetag(interaction);
        return;
      case "models":
        await this.handleAssistantModels(interaction);
        return;
      default:
        await interaction.editReply(`Unsupported assistant subcommand: ${subcommand}`);
    }
  }

  private async handleAssistantAgenda(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = interaction.options.getString("context") as
      | "work"
      | "personal"
      | "home"
      | "errands"
      | "health"
      | "planning"
      | null;
    const agenda = this.assistant!.getAgenda(context ?? undefined);
    await this.editReplyWithChunks(
      interaction,
      buildAttachedTextReply({
        headerLines: [buildAgendaSummary(agenda)],
        body: renderAgendaMarkdown(agenda),
        attachmentName: "assistant-agenda.md",
        attachmentNotice: "Full agenda attached as a Markdown file.",
      })
    );
  }

  private async handleAssistantInbox(interaction: ChatInputCommandInteraction): Promise<void> {
    const context = interaction.options.getString("context") as
      | "work"
      | "personal"
      | "home"
      | "errands"
      | "health"
      | "planning"
      | null;
    const inbox = this.assistant!.listInbox(25, context ?? undefined);
    const body = renderInboxMarkdown(inbox, this.config.assistant.timeZone, new Date().toISOString());
    const summary = inbox.length === 0
      ? "Your assistant inbox is clear."
      : `Your assistant inbox has ${inbox.length} item${inbox.length === 1 ? "" : "s"} waiting for triage.`;
    await this.editReplyWithChunks(
      interaction,
      buildAttachedTextReply({
        headerLines: [summary],
        body,
        attachmentName: "assistant-inbox.md",
        attachmentNotice: "Full inbox attached as a Markdown file.",
      })
    );
  }

  private async handleAssistantFind(interaction: ChatInputCommandInteraction): Promise<void> {
    const query = interaction.options.getString("query", true);
    const context = interaction.options.getString("context") as
      | "work"
      | "personal"
      | "home"
      | "errands"
      | "health"
      | "planning"
      | null;
    const results = this.assistant!.search(query, {
      context: context ?? undefined,
      limit: 20,
    });
    const body = renderSearchMarkdown(query, results, this.config.assistant.timeZone, new Date().toISOString());
    const summary = results.length === 0
      ? `I couldn't find anything matching "${query}".`
      : `I found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}".`;
    await this.editReplyWithChunks(
      interaction,
      buildAttachedTextReply({
        headerLines: [summary],
        body,
        attachmentName: "assistant-search.md",
        attachmentNotice: "Full search results attached as a Markdown file.",
      })
    );
  }

  private async handleAssistantDone(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = interaction.options.getString("task", true);
    const task = await this.assistant!.completeTask(taskId);
    await interaction.editReply(`Completed task \`${task.id}\`: ${task.title}`);
  }

  private async handleAssistantSnooze(interaction: ChatInputCommandInteraction): Promise<void> {
    const taskId = interaction.options.getString("task", true);
    const when = interaction.options.getString("when", true);
    const parsed = new Date(when);
    if (Number.isNaN(parsed.getTime())) {
      await interaction.editReply("I couldn't parse that snooze time. Use an ISO timestamp like 2026-04-25T14:00:00-04:00.");
      return;
    }

    const task = await this.assistant!.snoozeTask(taskId, parsed.toISOString());
    await interaction.editReply(`Snoozed task \`${task.id}\` to ${parsed.toISOString()}.`);
  }

  private async handleAssistantRetag(interaction: ChatInputCommandInteraction): Promise<void> {
    const itemId = interaction.options.getString("item", true);
    const context = interaction.options.getString("context", true) as
      | "work"
      | "personal"
      | "home"
      | "errands"
      | "health"
      | "planning";
    const result = await this.assistant!.retagItem(itemId, context);
    await interaction.editReply(`Retagged ${result.type} \`${result.id}\` to \`${context}\`.`);
  }

  private async handleAssistantModels(interaction: ChatInputCommandInteraction): Promise<void> {
    const scope = interaction.options.getString("scope") as "global" | "discord-channel" | null;
    const feature = interaction.options.getString("feature") as
      | "classification"
      | "query"
      | "summary"
      | "planning"
      | "verification"
      | "review"
      | null;
    const profile = interaction.options.getString("profile") as "cheap" | "default" | "deep" | null;

    if (feature || profile || scope) {
      if (!feature || !profile || !scope) {
        await interaction.editReply("To set a model override, pass `scope`, `feature`, and `profile` together. Leave them blank to inspect current settings.");
        return;
      }

      const override = this.assistant!.setModelOverride({
        scope,
        scopeId: scope === "global" ? "global" : interaction.channelId,
        feature,
        profile,
      });
      await interaction.editReply(
        `Updated assistant model routing: scope=\`${override.scope}\`, feature=\`${override.feature}\`, profile=\`${override.profile}\`.`
      );
      return;
    }

    const state = this.assistant!.getModelState({
      source: "discord",
      channelId: interaction.channelId,
    });
    const lines = [
      "Assistant model routing:",
      `Profiles: cheap=\`${state.routing.profiles.cheap}\`, default=\`${state.routing.profiles.default}\`, deep=\`${state.routing.profiles.deep}\``,
      `Effective: classification=\`${state.effective.classification}\`, query=\`${state.effective.query}\`, summary=\`${state.effective.summary}\`, planning=\`${state.effective.planning}\`, verification=\`${state.effective.verification}\`, review=\`${state.effective.review}\``,
    ];

    if (state.overrides.length > 0) {
      lines.push("", "Overrides:");
      for (const override of state.overrides.slice(0, 10)) {
        lines.push(`- ${override.scope}:${override.scopeId} ${override.feature} -> ${override.profile}`);
      }
    }

    await interaction.editReply(lines.join("\n"));
  }

  private async handleMaverickCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "brief" && subcommand !== "audit") {
      await interaction.reply({
        content: `Unsupported maverick subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (subcommand === "audit") {
      const scope = (interaction.options.getString("scope") ?? "all") as "git" | "discord" | "state" | "all";
      const report = this.orchestrator.getAuditReport(scope);
      const lines = [
        `Instance: \`${report.instanceId}\``,
        `Scope: \`${report.scope}\``,
        `Projects: ${report.projects.length}`,
        "",
      ];

      for (const project of report.projects) {
        lines.push(`## ${project.name} (\`${project.id}\`)`);
        lines.push(`- Workspace kind: \`${project.workspaceKind}\``);
        lines.push(`- Repo: ${project.repoPath}`);
        if (project.defaultWorktreeBaseBranch) {
          lines.push(`- Default base branch: \`${project.defaultWorktreeBaseBranch}\``);
        }
        if (project.productionBranch) {
          lines.push(`- Production branch: \`${project.productionBranch}\``);
        }
        if (project.defaultLanes.length > 0) {
          lines.push(
            `- Durable lanes: ${project.defaultLanes.map((lane) => `\`${lane.id}\` -> \`${lane.baseBranch}\``).join(", ")}`
          );
        }
        if (project.epicBranches.length > 0) {
          lines.push(
            `- Epic branches: ${project.epicBranches.map((epic) => `\`${epic.id}\` -> \`${epic.branch}\``).join(", ")}`
          );
        }
        if (project.bootstrap) {
          lines.push(
            `- Bootstrap: missing ${project.bootstrap.missingFiles.length}, created ${project.bootstrap.createdFiles.length}`
          );
        }
        if (project.activeWorkstreams.length > 0) {
          lines.push(`- Active workstreams: ${project.activeWorkstreams.length}`);
        }
        if (project.threadBindings.length > 0) {
          lines.push(`- Thread bindings: ${project.threadBindings.length}`);
        }
        if (project.gitAudit?.mode === "git") {
          lines.push(`- Root branch: \`${project.gitAudit.rootBranch ?? "unknown"}\``);
          lines.push(`- Root dirty: ${project.gitAudit.rootDirty ? "yes" : "no"}`);
          if ((project.gitAudit.orphanedWorktrees?.length ?? 0) > 0) {
            lines.push(`- Orphaned worktrees: ${project.gitAudit.orphanedWorktrees?.length ?? 0}`);
          }
          if ((project.gitAudit.workstreamMismatches?.length ?? 0) > 0) {
            lines.push(`- Workstream mismatches: ${project.gitAudit.workstreamMismatches?.length ?? 0}`);
          }
        }
        lines.push("");
      }

      if (report.discord) {
        lines.push(`Discord routes: ${report.discord.routes.length}`);
        lines.push(`Persisted thread bindings: ${report.discord.threadBindingCount}`);
        lines.push("");
      }

      if (report.state) {
        lines.push(`Active workstreams: ${report.state.activeWorkstreamCount}`);
        lines.push(`Legacy-root workstreams: ${report.state.legacyRootWorkstreams.length}`);
      }

      await this.editReplyWithChunks(interaction, lines.join("\n"));
      return;
    }

    const result = await this.orchestrator.generateBrief({
      trigger: "manual",
      requestedBy: interaction.user.id,
      channelId: this.config.brief.discordChannelId ?? interaction.channelId,
    });

    await interaction.editReply(
      [
        "Claude brief generated.",
        result.channelId ? `Posted to channel: \`${result.channelId}\`` : "Posted channel: unavailable",
        result.storagePath ? `Saved to: \`${result.storagePath}\`` : null,
        `Summary: ${truncate(result.summary, 1200)}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  private async captureStructuredWorkNote(
    interaction: ChatInputCommandInteraction,
    params: {
      noteKind: "general" | "project" | "study" | "acceptance-criteria";
      defaultSmartGoalIds: string[];
    }
  ): Promise<void> {
    const details = interaction.options.getString("details") ?? "";
    const title = interaction.options.getString("title");
    const projectName = interaction.options.getString("project");
    const smartGoalChoice = interaction.options.getString("smart_goal") as WorkSmartGoalChoice | null;
    const attachments = ["attachment", "attachment_2", "attachment_3", "attachment_4"]
      .map((optionName) => interaction.options.getAttachment(optionName))
      .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
      .map((attachment) => this.toAssistantAttachment(attachment));

    if (!details.trim() && !title?.trim() && attachments.length === 0) {
      await interaction.editReply("Add note details, a title, or an attachment so I have something to save.");
      return;
    }

    const result = await this.assistant!.processIncomingMessage({
      source: "discord",
      body: details,
      from: interaction.user.id,
      replyTarget: interaction.channelId,
      attachments,
      metadata: {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        interactionId: interaction.id,
        username: interaction.user.username,
        structuredCapture: true,
        structuredSubcommand: interaction.options.getSubcommand(),
      },
      structuredNote: {
        title,
        content: details,
        context: "work",
        noteKind: params.noteKind,
        projectName,
        smartGoalIds: this.resolveWorkSmartGoalIds(smartGoalChoice, params.defaultSmartGoalIds),
      },
    });

    await interaction.editReply(result.reply);
  }

  private async handleRecentWorkNotes(interaction: ChatInputCommandInteraction): Promise<void> {
    const limit = interaction.options.getInteger("limit") ?? 5;
    const notes = this.assistant!
      .listNotes(limit * 4)
      .filter((note) => note.note_context === "work")
      .slice(0, limit);

    if (notes.length === 0) {
      await interaction.editReply("No work notes have been captured yet.");
      return;
    }

    const lines = ["Recent work notes:"];
    for (const note of notes) {
      const parts = [
        note.note_kind ? `[${note.note_kind}]` : null,
        note.project_name ? `project: ${note.project_name}` : null,
        note.storage_path ? `file: ${note.storage_path}` : null,
      ].filter(Boolean);
      lines.push(`- ${note.created_at}: ${note.title}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`);
    }

    await interaction.editReply(lines.join("\n"));
  }

  private async handleWorkstreamStart(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("name", true);
    const description = interaction.options.getString("description") ?? undefined;

    if (this.isLegacyAssistantChannel(interaction.channelId)) {
      throw new Error(
        "This channel is reserved for assistant chat. Start workstreams in the routed workstream channel instead."
      );
    }

    const route = this.resolveInteractionRoute(interaction);
    const threadContext = this.resolveInteractionThreadContext(interaction);
    const explicitProjectId = interaction.options.getString("project");
    const explicitEpic = this.parseEpicChoice(interaction.options.getString("epic"));
    const projectId = this.resolveProjectId(
      interaction,
      explicitProjectId,
      explicitEpic?.projectId ?? null,
      threadContext?.projectId ?? route?.projectId ?? null
    );
    const epic = this.resolveEpic(projectId, route, explicitEpic, threadContext);
    const binding = this.resolveWorkstreamChannelBinding(interaction);

    const workstream = await this.orchestrator.createWorkstream({
      projectId,
      name,
      description,
      discordChannelId: binding.channelId,
      discordThreadId: binding.threadId,
      discordParentChannelId: binding.parentChannelId,
      baseBranch: epic?.branch,
      lane: epic?.lane,
      epicId: persistedEpicIdForResolvedEpic(epic),
    });

    if (binding.threadId && binding.parentChannelId) {
      const assistantEnabled = threadContext?.assistantEnabled ?? route?.assistantEnabled ?? false;
      const ownerInstanceId = threadContext?.ownerInstanceId ?? route?.ownerInstanceId ?? this.instanceId;
      this.orchestrator.upsertDiscordThreadBinding({
        threadId: binding.threadId,
        parentChannelId: binding.parentChannelId,
        projectId,
        epicId: persistedEpicIdForResolvedEpic(epic) ?? null,
        lane: epic?.lane ?? threadContext?.lane ?? null,
        baseBranch: epic?.branch ?? threadContext?.baseBranch ?? null,
        assistantEnabled,
        ownerInstanceId,
        source: threadContext?.source ?? "manual",
      });
    }

    await interaction.editReply(
      [
        `Created workstream \`${workstream.name}\``,
        `ID: \`${workstream.id}\``,
        `Project: \`${projectId}\``,
        epic && epic.source !== "default" ? `Epic: \`${epic.id}\` (${epic.source})` : null,
        epic ? `Lane: \`${epic.lane}\`` : null,
        epic ? `Base branch: \`${epic.branch}\`${epic.source === "default" ? " (default)" : ""}` : null,
        workstream.branch ? `Branch: \`${workstream.branch}\`` : `Branch: \`${workstream.workspace_mode}\` workspace`,
        workstream.cwd ? `Workspace: \`${workstream.cwd}\`` : null,
        `Codex thread: \`${workstream.codex_thread_id}\``,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  private async handleWorkstreamStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const explicitId = interaction.options.getString("workstream");

    if (explicitId) {
      const workstream = this.orchestrator.getWorkstream(explicitId);
      if (!workstream) {
        await interaction.editReply(`Workstream not found: \`${explicitId}\``);
        return;
      }

      await this.editReplyWithChunks(
        interaction,
        this.buildWorkstreamStatusReply(this.formatWorkstream(workstream))
      );
      return;
    }

    const current = this.orchestrator.getChannelWorkstream(interaction.channelId);
    if (current) {
      await this.editReplyWithChunks(
        interaction,
        this.buildWorkstreamStatusReply(this.formatWorkstream(current))
      );
      return;
    }

    const channelWorkstreams = this.orchestrator.listChannelWorkstreams(interaction.channelId, {
      includeArchived: true,
    });
    if (channelWorkstreams.length === 0) {
      await interaction.editReply("This channel is not bound to any Maverick workstreams yet.");
      return;
    }

    const lines = ["Workstreams in this channel:"];
    for (const workstream of channelWorkstreams.slice(0, 10)) {
      const snapshot = this.orchestrator.getWorkstreamStatusSnapshot(workstream.id);
      const suffix = snapshot ? `${workstream.state} / ${snapshot.health}` : workstream.state;
      lines.push(`- \`${workstream.id}\` ${workstream.name} [${suffix}]`);
    }

    await this.editReplyWithChunks(interaction, this.buildWorkstreamStatusReply(lines.join("\n")));
  }

  private async handleDispatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const providedInstruction = interaction.options.getString("instruction", true);
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const planningContext = this.orchestrator.getPlanningContext(workstream.id);
    const normalizedInstruction = providedInstruction.trim().toLowerCase();
    const instruction =
      planningContext?.finalExecutionPrompt &&
      ["resume", "dispatch", "stored plan", "use stored plan"].includes(normalizedInstruction)
        ? planningContext.originalInstruction
        : providedInstruction;

    await this.startAsyncWorkstreamCommand(interaction, workstream, "dispatch", {
      description: "Starting Codex implementation in the background.",
      run: async () => {
        await this.orchestrator.dispatch(workstream.id, instruction);
      },
    });
  }

  private async handleSteer(interaction: ChatInputCommandInteraction): Promise<void> {
    const instruction = interaction.options.getString("instruction", true);
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

    await this.orchestrator.steer(workstream.id, instruction);
    await interaction.editReply(`Sent steering guidance to \`${workstream.name}\`.`);
  }

  private async handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

    await this.orchestrator.cancel(workstream.id);
    await interaction.editReply(`Cancelled the active turn for \`${workstream.name}\`.`);
  }

  private async handleArchive(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const archived = await this.orchestrator.archive(workstream.id, interaction.user.id);

    await interaction.editReply(
      [
        `Archived \`${archived.name}\`.`,
        `ID: \`${archived.id}\``,
        "This workstream will no longer be inferred as the active workstream for this channel.",
      ].join("\n")
    );
  }

  private async handleReview(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const target = interaction.options.getString("target") ?? undefined;
    const useClaude = interaction.options.getBoolean("claude") ?? false;

    await this.startAsyncWorkstreamCommand(interaction, workstream, "review", {
      description: `Running ${useClaude ? "Claude" : "primary"} review in the background.`,
      run: async (channel) => {
        const result = await this.orchestrator.review(workstream.id, target, {
          reviewer: useClaude ? "claude" : "primary",
          trigger: "manual",
        });

        if (!useClaude && channel) {
          await this.safeSend(
            channel,
            this.buildReviewCommandCompletedMessage(
              workstream.id,
              workstream.name,
              useClaude ? "claude" : "primary",
              result.severity,
              result.findings,
            ),
          );
        }
      },
    });
  }

  private async handleVerify(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

    await this.startAsyncWorkstreamCommand(interaction, workstream, "verify", {
      description: "Running Claude verification in the background.",
      run: async () => {
        await this.orchestrator.verify(workstream.id, {
          trigger: "manual",
        });
      },
    });
  }

  private async handleFinish(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

    await this.startAsyncWorkstreamCommand(interaction, workstream, "finish", {
      description: "Finishing the verified workstream into the durable lane branch.",
      run: async () => {
        await this.orchestrator.finishWorkstream(workstream.id, {
          trigger: "manual",
          finishedBy: interaction.user.id,
        });
      },
    });
  }

  private async handlePlan(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const instruction = interaction.options.getString("instruction", true);
    const resume = interaction.options.getBoolean("resume") ?? false;
    const planningContext = resume ? this.orchestrator.getPlanningContext(workstream.id) : null;
    const effectiveInstruction = resume
      ? planningContext?.originalInstruction ?? instruction
      : instruction;

    await this.startAsyncWorkstreamCommand(interaction, workstream, "plan", {
      description: resume
        ? "Resuming Claude planning in the background."
        : "Running Claude planning in the background.",
      run: async () => {
        await this.orchestrator.generatePlan(workstream.id, effectiveInstruction, "manual", {
          resumeExisting: resume,
        });
      },
    });
  }

  private async handleAnswerPlan(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const answersText = interaction.options.getString("answers", true);
    const parsed = parsePlanningAnswerInput(answersText);

    if (parsed.invalidLines.length > 0) {
      throw new Error(
        `Answer lines must use "question-id: answer". Invalid lines: ${parsed.invalidLines.join(" | ")}`
      );
    }

    await this.startAsyncWorkstreamCommand(interaction, workstream, "answer-plan", {
      description: "Merging planning answers and resuming Claude planning in the background.",
      run: async () => {
        await this.orchestrator.provideDecisionAnswers(workstream.id, parsed.answers, interaction.user.id);
      },
    });
  }

  private async handleRepostPlan(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const planningContext = this.orchestrator.getPlanningContext(workstream.id);
    if (!planningContext) {
      await interaction.editReply(
        `Workstream \`${workstream.name}\` has no stored planning context to repost. Run \`/workstream plan\` first.`
      );
      return;
    }

    const channel = await this.resolveAsyncCommandChannel(workstream, interaction.channelId);
    if (!channel) {
      await interaction.editReply("I could not find a Discord channel to repost the stored plan into.");
      return;
    }

    const needsAnswers = planningContext.pendingQuestions.length > 0;
    const renderedPlan = renderPlanningSummary(planningContext, {
      includeAgentSections: !needsAnswers,
      includeRawOutput: !needsAnswers,
    });
    const formattedMarkdown = planningContext.explanation?.markdown?.trim() || renderedPlan;
    const instruction =
      planningContext.originalInstruction.trim() ||
      workstream.current_goal?.trim() ||
      workstream.description?.trim() ||
      workstream.name;

    for (const message of buildPlanNotificationMessages({
      workstreamId: workstream.id,
      workstreamName: workstream.name,
      instruction,
      renderedPlan,
      formattedMarkdown,
      finalExecutionPrompt: planningContext.finalExecutionPrompt,
      needsAnswers,
      questions: planningContext.pendingQuestions,
    })) {
      await this.safeSend(channel, message);
    }

    await interaction.editReply(
      [
        `Reposted the stored planning output for \`${workstream.name}\`.`,
        `Workstream: \`${workstream.id}\``,
        "No Claude planning work was rerun.",
      ].join("\n")
    );
  }

  private async startAsyncWorkstreamCommand(
    interaction: ChatInputCommandInteraction,
    workstream: WorkstreamRow,
    command: AsyncWorkstreamCommand,
    params: {
      description: string;
      run: (channel: SendableChannel | null) => Promise<void>;
    },
  ): Promise<void> {
    const label = this.asyncCommandLabel(command);
    await interaction.editReply({
      content: [
        `Started ${label} for \`${workstream.name}\`.`,
        params.description,
        "Maverick will post progress and results in this workstream channel instead of waiting on the slash command.",
        "You can run `/workstream status` at any time.",
      ].join("\n"),
    });

    const requestedChannelId = interaction.channelId;
    this.runBackgroundTask(`workstream.${command}`, async () => {
      const channel = await this.resolveAsyncCommandChannel(workstream, requestedChannelId);
      if (channel) {
        try {
          await this.safeSend(
            channel,
            this.buildAsyncCommandStartedMessage(workstream, command, params.description),
          );
        } catch (error) {
          log.warn({ err: error, workstreamId: workstream.id, command }, "Failed to send async command start notification");
        }
      }

      try {
        await params.run(channel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ err: error, workstreamId: workstream.id, command }, "Async workstream command failed");
        if (channel) {
          await this.safeSend(channel, this.buildAsyncCommandFailedMessage(workstream, command, message));
        }
      }
    });
  }

  private async resolveAsyncCommandChannel(
    workstream: WorkstreamRow,
    requestedChannelId: string,
  ): Promise<SendableChannel | null> {
    return await this.fetchTextChannel(requestedChannelId)
      ?? await this.resolveNotificationChannel(workstream, "notifications");
  }

  private asyncCommandLabel(command: AsyncWorkstreamCommand): string {
    switch (command) {
      case "plan":
        return "planning";
      case "answer-plan":
        return "planning resume";
      case "dispatch":
        return "implementation dispatch";
      case "review":
        return "review";
      case "verify":
        return "verification";
      case "finish":
        return "workstream finish";
    }
  }

  private buildAsyncCommandStartedMessage(
    workstream: WorkstreamRow,
    command: AsyncWorkstreamCommand,
    description: string,
  ): MessageCreateOptions {
    return {
      content: [
        `Maverick started ${this.asyncCommandLabel(command)} for \`${workstream.name}\`.`,
        `Workstream: \`${workstream.id}\``,
        description,
        "Results will be posted here when the background work completes.",
      ].join("\n"),
    };
  }

  private buildAsyncCommandFailedMessage(
    workstream: WorkstreamRow,
    command: AsyncWorkstreamCommand,
    message: string,
  ): MessageCreateOptions {
    return {
      content: [
        `Maverick failed ${this.asyncCommandLabel(command)} for \`${workstream.name}\`.`,
        `Workstream: \`${workstream.id}\``,
        `Error: ${truncate(message, 1500)}`,
        "Run `/workstream status` to inspect the current stored state before retrying.",
      ].join("\n"),
    };
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith(`${PLANNING_ANSWER_PREFIX}:`)) {
      await this.handlePlanningAnswerButton(interaction);
      return;
    }

    const [prefix, action, approvalId] = interaction.customId.split(":");
    if (prefix !== APPROVAL_PREFIX || !approvalId) {
      return;
    }

    const approved = action === "approve";
    await this.orchestrator.resolveApproval(approvalId, approved, interaction.user.id);

    const originalContent = "content" in interaction.message ? interaction.message.content : "Approval handled.";
    await interaction.update({
      content: `${originalContent}\n\nResolved by <@${interaction.user.id}>: \`${approved ? "approved" : "denied"}\``,
      components: [],
    });
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (interaction.customId.startsWith(`${PLANNING_ANSWER_MODAL_PREFIX}:`)) {
      await this.handlePlanningAnswerModalSubmit(interaction);
    }
  }

  private planningAnswerDraftKey(workstreamId: string, userId: string): string {
    return `${workstreamId}:${userId}`;
  }

  private pendingPlanningQuestions(workstream: WorkstreamRow): PendingPlanningDecision[] {
    return this.orchestrator.getPlanningContext(workstream.id)?.pendingQuestions ?? [];
  }

  private buildPlanningAnswerModal(
    workstream: WorkstreamRow,
    userId: string,
    pageIndex: number,
    questions: PendingPlanningDecision[],
  ): ModalBuilder {
    const pageCount = planningQuestionPageCount(questions);
    const startIndex = pageIndex * PLANNING_QUESTIONS_PER_MODAL;
    const pageQuestions = questions.slice(startIndex, startIndex + PLANNING_QUESTIONS_PER_MODAL);
    const draft = this.planningAnswerDrafts.get(this.planningAnswerDraftKey(workstream.id, userId)) ?? {};
    const contextAnswers = this.orchestrator.getPlanningContext(workstream.id)?.answers ?? {};
    const modal = new ModalBuilder()
      .setCustomId(`${PLANNING_ANSWER_MODAL_PREFIX}:${workstream.id}:${pageIndex}`)
      .setTitle(pageCount === 1 ? "Planning Answers" : `Planning Answers ${pageIndex + 1}/${pageCount}`);

    const rows = pageQuestions.map((question, localIndex) => {
      const displayIndex = startIndex + localIndex + 1;
      const input = new TextInputBuilder()
        .setCustomId(`q-${displayIndex - 1}`)
        .setLabel(truncate(`Q${displayIndex}: ${question.question}`, 45))
        .setPlaceholder(truncate(question.question, 100))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);
      const existingAnswer = draft[question.id] ?? contextAnswers[question.id]?.answer;
      if (existingAnswer) {
        input.setValue(truncate(existingAnswer, 4000));
      }
      return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    });

    modal.addComponents(...rows);
    return modal;
  }

  private async handlePlanningAnswerButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, workstreamId, pageRaw] = interaction.customId.split(":");
    if (action !== "page" || !workstreamId) {
      await interaction.reply({
        content: "That planning answer action is not recognized.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const workstream = this.orchestrator.getWorkstream(workstreamId);
    if (!workstream) {
      await interaction.reply({
        content: `Workstream not found: \`${workstreamId}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const questions = this.pendingPlanningQuestions(workstream);
    if (questions.length === 0) {
      await interaction.reply({
        content: `Workstream \`${workstream.name}\` has no pending planning questions right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pageIndex = Number.parseInt(pageRaw ?? "0", 10);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= planningQuestionPageCount(questions)) {
      await interaction.reply({
        content: "That planning answer page is no longer available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.showModal(this.buildPlanningAnswerModal(workstream, interaction.user.id, pageIndex, questions));
  }

  private async handlePlanningAnswerModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const [, workstreamId, pageRaw] = interaction.customId.split(":");
    const workstream = workstreamId ? this.orchestrator.getWorkstream(workstreamId) : null;
    if (!workstream) {
      await interaction.reply({
        content: `Workstream not found: \`${workstreamId ?? "unknown"}\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const questions = this.pendingPlanningQuestions(workstream);
    if (questions.length === 0) {
      await interaction.reply({
        content: `Workstream \`${workstream.name}\` has no pending planning questions right now.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pageIndex = Number.parseInt(pageRaw ?? "0", 10);
    const startIndex = pageIndex * PLANNING_QUESTIONS_PER_MODAL;
    const pageQuestions = questions.slice(startIndex, startIndex + PLANNING_QUESTIONS_PER_MODAL);
    const draftKey = this.planningAnswerDraftKey(workstream.id, interaction.user.id);
    const draft = { ...(this.planningAnswerDrafts.get(draftKey) ?? {}) };

    for (let localIndex = 0; localIndex < pageQuestions.length; localIndex += 1) {
      const question = pageQuestions[localIndex];
      if (!question) {
        continue;
      }
      const fieldId = `q-${startIndex + localIndex}`;
      const value = interaction.fields.getTextInputValue(fieldId).trim();
      if (value) {
        draft[question.id] = value;
      }
    }

    this.planningAnswerDrafts.set(draftKey, draft);
    const unanswered = questions.filter((question) => !draft[question.id]?.trim());
    if (unanswered.length > 0) {
      const rows = buildPlanningAnswerButtonRows(workstream.id, questions);
      const recordedOnPage = pageQuestions.filter((question) => draft[question.id]?.trim()).length;
      await interaction.reply({
        content: [
          `Recorded ${recordedOnPage} answer(s) for \`${workstream.name}\`.`,
          `${unanswered.length} planning question${unanswered.length === 1 ? "" : "s"} still need an answer.`,
          `Remaining: ${unanswered.map((question) => `\`${question.id}\``).join(", ")}`,
          "Use the button(s) below to keep going.",
        ].join("\n"),
        components: rows,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    this.planningAnswerDrafts.delete(draftKey);
    await interaction.reply({
      content: [
        `Recorded all ${questions.length} planning answer${questions.length === 1 ? "" : "s"} for \`${workstream.name}\`.`,
        "Maverick is resuming planning in the background.",
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });

    const requestedChannelId = interaction.channelId ?? workstream.discord_channel_id ?? "";
    this.runBackgroundTask("planning.answer-modal", async () => {
      const channel = requestedChannelId
        ? await this.resolveAsyncCommandChannel(workstream, requestedChannelId)
        : await this.resolveNotificationChannel(workstream, "notifications");

      if (channel) {
        await this.safeSend(channel, this.buildAsyncCommandStartedMessage(
          workstream,
          "answer-plan",
          "Merging planning answers and resuming Claude planning in the background.",
        ));
      }

      await this.orchestrator.provideDecisionAnswers(workstream.id, draft, interaction.user.id);
    });
  }

  private resolveProjectId(
    interaction: ChatInputCommandInteraction,
    explicitProjectId: string | null,
    epicProjectId: string | null,
    routedProjectId: string | null
  ): string {
    if (explicitProjectId && epicProjectId && explicitProjectId !== epicProjectId) {
      throw new Error(
        `Epic selection belongs to project "${epicProjectId}", but the command specified project "${explicitProjectId}".`
      );
    }

    if (explicitProjectId) {
      return explicitProjectId;
    }

    if (epicProjectId) {
      return epicProjectId;
    }

    if (routedProjectId) {
      return routedProjectId;
    }

    if (this.config.projects.length === 1) {
      return this.config.projects[0].id;
    }

    throw new Error("No project could be inferred for this channel. Pass the project explicitly.");
  }

  private resolveWorkstream(interaction: ChatInputCommandInteraction, explicitWorkstreamId: string | null): WorkstreamRow {
    if (explicitWorkstreamId) {
      const workstream = this.orchestrator.getWorkstream(explicitWorkstreamId);
      if (!workstream) {
        throw new Error(`Workstream not found: ${explicitWorkstreamId}`);
      }
      return workstream;
    }

    const inferred = this.orchestrator.getChannelWorkstream(interaction.channelId);
    if (inferred) {
      return inferred;
    }

    const channelWorkstreams = this.orchestrator.listChannelWorkstreams(interaction.channelId);
    if (channelWorkstreams.length > 1) {
      throw new Error("This channel has multiple workstreams. Pass the workstream id explicitly.");
    }

    throw new Error("No workstream could be inferred for this channel.");
  }

  private resolveWorkstreamChannelBinding(
    interaction: ChatInputCommandInteraction,
  ): WorkstreamChannelBinding {
    const route = this.resolveInteractionRoute(interaction);
    return resolveWorkstreamChannelBindingForIds({
      interactionChannelId: interaction.channelId,
      parentChannelId: this.parentChannelIdForInteraction(interaction),
      routeChannelId: route?.channelId ?? null,
    });
  }

  private formatWorkstream(workstream: WorkstreamRow): string {
    const snapshot = this.orchestrator.getWorkstreamStatusSnapshot(workstream.id);
    if (!snapshot) {
      return [
        `Workstream: \`${workstream.name}\``,
        `ID: \`${workstream.id}\``,
        `Project: \`${workstream.project_id}\``,
        `State: \`${workstream.state}\``,
      ].join("\n");
    }

    return renderWorkstreamStatusSnapshot(snapshot);
  }

  private buildWorkstreamStatusReply(statusText: string): InteractionEditReplyOptions {
    return buildAttachedTextReply({
      headerLines: ["Workstream status:"],
      body: statusText,
      previewLimit: DISCORD_STATUS_PREVIEW_LIMIT,
      attachmentName: "workstream-status.md",
      attachmentNotice: "Status is long, so the full report is attached as a Markdown file.",
    });
  }

  private resolveLaneCommandTarget(interaction: ChatInputCommandInteraction): {
    projectId: string;
    laneId: string | null;
  } {
    const route = this.resolveInteractionRoute(interaction);
    const threadContext = this.resolveInteractionThreadContext(interaction);
    const explicitProjectId = interaction.options.getString("project");
    const projectId = this.resolveProjectId(
      interaction,
      explicitProjectId,
      null,
      threadContext?.projectId ?? route?.projectId ?? null,
    );
    const explicitLane = interaction.options.getString("lane");
    const inferredLane =
      explicitLane ??
      (threadContext?.projectId === projectId ? threadContext.epicId ?? threadContext.lane : null) ??
      (route?.projectId === projectId ? route.epicId ?? route.lane ?? route.baseBranch ?? null : null);

    return {
      projectId,
      laneId: inferredLane,
    };
  }

  private renderLaneLifecycleResult(title: string, result: LaneLifecycleResult): string {
    const statusLine =
      result.git.status === "merged"
        ? "Merged and pushed."
        : result.git.status === "ready"
          ? "Ready to promote."
          : `Blocked: ${result.git.reason ?? "lane and production are not in a promotable state."}`;

    return [
      `# ${title}`,
      statusLine,
      "",
      `Project: \`${result.lane.projectId}\``,
      `Lane: \`${result.lane.laneId}\` (${result.lane.source})`,
      `Durable branch: \`${result.lane.durableBranch}\``,
      `Production branch: \`${result.lane.productionBranch}\``,
      `Pushed: ${result.git.pushed ? "yes" : "no"}`,
      result.git.headSha ? `Source SHA: \`${result.git.headSha}\`` : null,
      result.git.targetShaBefore ? `Production before: \`${result.git.targetShaBefore}\`` : null,
      result.git.targetShaAfter ? `Production after: \`${result.git.targetShaAfter}\`` : null,
      result.git.rollbackCommand ? `Rollback: \`${result.git.rollbackCommand}\`` : null,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private projectIdForChannel(channelId: string, parentChannelId?: string | null): string | null {
    const threadContext = this.resolveThreadContext(channelId, parentChannelId);
    if (threadContext) {
      return threadContext.projectId;
    }

    const route = this.routeForChannel(channelId, parentChannelId);
    return route?.projectId ?? null;
  }

  private getProjectConfig(projectId: string): ProjectConfig {
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  private parseEpicChoice(rawEpicChoice: string | null): ParsedEpicChoice | null {
    return parseWorkstreamEpicChoice(rawEpicChoice);
  }

  private resolveEpic(
    projectId: string,
    route: DiscordRoute | null,
    explicitEpic: ParsedEpicChoice | null,
    threadContext?: ResolvedThreadContext | null,
  ): ResolvedEpic | null {
    const project = this.getProjectConfig(projectId);

    if (explicitEpic && explicitEpic.projectId !== projectId) {
      throw new Error(
        `Epic selection "${explicitEpic.projectId}:${explicitEpic.epicId}" does not belong to project "${projectId}".`
      );
    }

    if (explicitEpic?.kind === "lane") {
      const lane = project.defaultLanes.find((candidate) => candidate.id === explicitEpic.epicId);
      if (!lane) {
        throw new Error(`Project "${projectId}" does not define durable lane "${explicitEpic.epicId}".`);
      }

      return {
        id: "default",
        branch: lane.baseBranch,
        lane: lane.id,
        source: "default",
      };
    }

    const explicitEpicId = explicitEpic?.kind === "epic" ? explicitEpic.epicId : undefined;
    const epicId =
      explicitEpicId ??
      (threadContext?.projectId === projectId ? threadContext.epicId ?? undefined : undefined) ??
      (route?.projectId === projectId ? route.epicId : undefined);
    if (epicId) {
      const epic = project.epicBranches.find((candidate) => candidate.id === epicId);
      if (epic) {
        return {
          id: epic.id,
          branch: epic.branch,
          lane: workstreamLaneForEpic(epic),
          source: explicitEpic ? "explicit" : "route",
        };
      }

      const lane = project.defaultLanes.find((candidate) => candidate.id === epicId);
      if (explicitEpic && lane) {
        return {
          id: "default",
          branch: lane.baseBranch,
          lane: lane.id,
          source: "default",
        };
      }

      throw new Error(`Project "${projectId}" does not define epic "${epicId}".`);
    }

    if (threadContext?.projectId === projectId && threadContext.baseBranch) {
      return {
        id: "default",
        branch: threadContext.baseBranch,
        lane: threadContext.lane ?? project.id,
        source: "default",
      };
    }

    if (project.requireEpicForWorktree) {
      throw new Error(
        `Project "${projectId}" requires an epic selection. Start the workstream in a routed epic channel or pass the epic option explicitly.`
      );
    }

    throw new Error(
      `No durable lane could be inferred for project "${projectId}". Start the workstream inside a Discord thread whose name matches a configured lane or epic, or pass the epic option explicitly.`
    );
  }

  private resolveInteractionRoute(interaction: ChatInputCommandInteraction): DiscordRoute | null {
    return this.routeForChannel(interaction.channelId, this.parentChannelIdForInteraction(interaction));
  }

  private resolveInteractionThreadContext(interaction: ChatInputCommandInteraction): ResolvedThreadContext | null {
    return this.resolveThreadContext(
      interaction.channelId,
      this.parentChannelIdForInteraction(interaction),
      this.threadNameFromInteraction(interaction),
    );
  }

  private parentChannelIdForInteraction(interaction: ChatInputCommandInteraction): string | null {
    const channel = interaction.channel;
    if (!channel) {
      return null;
    }

    switch (channel.type) {
      case ChannelType.PublicThread:
      case ChannelType.PrivateThread:
      case ChannelType.AnnouncementThread:
        return channel.parentId ?? null;
      default:
        return null;
    }
  }

  private routeForChannel(channelId: string, parentChannelId?: string | null): DiscordRoute | null {
    const directRoute = this.config.discord.routes.find((candidate) => candidate.channelId === channelId);
    if (directRoute) {
      return directRoute;
    }

    if (parentChannelId) {
      return this.config.discord.routes.find((candidate) => candidate.channelId === parentChannelId) ?? null;
    }

    return null;
  }

  private resolveAssistantThreadContext(message: Message): ResolvedThreadContext | null {
    const parentChannelId = this.parentChannelIdForMessage(message);
    const threadContext = this.resolveThreadContext(
      message.channelId,
      parentChannelId,
      this.threadNameFromMessage(message),
    );
    if (!threadContext || !threadContext.assistantEnabled) {
      return null;
    }

    return threadContext;
  }

  private isLegacyAssistantChannel(channelId: string): boolean {
    return this.config.assistant.enabled &&
      this.config.assistant.discord.enabled &&
      this.config.assistant.discord.channelIds.includes(channelId);
  }

  private parentChannelIdForMessage(message: Message): string | null {
    const channel = message.channel;
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      return channel.parentId ?? null;
    }

    return null;
  }

  private threadNameFromInteraction(interaction: ChatInputCommandInteraction): string | null {
    const channel = interaction.channel;
    if (!channel || !("name" in channel) || typeof channel.name !== "string") {
      return null;
    }

    return channel.name;
  }

  private threadNameFromMessage(message: Message): string | null {
    const channel = message.channel;
    if (!("name" in channel) || typeof channel.name !== "string") {
      return null;
    }

    return channel.name;
  }

  private normalizeLaneIdCandidate(value: string | null | undefined): string | null {
    if (!value) {
      return null;
    }

    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    return normalized.length > 0 ? normalized : null;
  }

  private resolveThreadContext(
    channelId: string,
    parentChannelId?: string | null,
    threadName?: string | null,
  ): ResolvedThreadContext | null {
    if (!parentChannelId) {
      return null;
    }

    const route = this.routeForChannel(channelId, parentChannelId);
    if (!route || route.channelId !== parentChannelId) {
      return null;
    }

    const existingBinding = this.orchestrator.getRepairedDiscordThreadBinding(channelId);
    if (existingBinding) {
      return {
        projectId: existingBinding.project_id,
        route,
        parentChannelId,
        threadId: channelId,
        lane: existingBinding.lane,
        baseBranch: existingBinding.base_branch,
        epicId: existingBinding.epic_id,
        assistantEnabled: Boolean(existingBinding.assistant_enabled),
        ownerInstanceId: existingBinding.owner_instance_id,
        source: "thread-binding",
        binding: existingBinding,
      };
    }

    const project = this.getProjectConfig(route.projectId);
    const normalizedThreadName = this.normalizeLaneIdCandidate(threadName);

    if (route.epicId) {
      const epic = project.epicBranches.find((candidate) => candidate.id === route.epicId);
      if (epic) {
        return {
          projectId: project.id,
          route,
          parentChannelId,
          threadId: channelId,
          lane: workstreamLaneForEpic(epic),
          baseBranch: route.baseBranch ?? epic.branch,
          epicId: epic.id,
          assistantEnabled: route.assistantEnabled,
          ownerInstanceId: route.ownerInstanceId ?? null,
          source: "route",
          binding: null,
        };
      }
    }

    if (route.lane) {
      const lane = project.defaultLanes.find((candidate) => candidate.id === route.lane);
      if (lane) {
        return {
          projectId: project.id,
          route,
          parentChannelId,
          threadId: channelId,
          lane: lane.id,
          baseBranch: route.baseBranch ?? lane.baseBranch,
          epicId: null,
          assistantEnabled: route.assistantEnabled || lane.assistantEnabled,
          ownerInstanceId: route.ownerInstanceId ?? lane.ownerInstanceId ?? null,
          source: "route",
          binding: null,
        };
      }
    }

    if (normalizedThreadName) {
      const matchingLane = project.defaultLanes.find((candidate) => candidate.id === normalizedThreadName);
      if (matchingLane) {
        const binding = this.orchestrator.upsertDiscordThreadBinding({
          threadId: channelId,
          parentChannelId,
          projectId: project.id,
          epicId: null,
          lane: matchingLane.id,
          baseBranch: matchingLane.baseBranch,
          assistantEnabled: route.assistantEnabled || matchingLane.assistantEnabled,
          ownerInstanceId: route.ownerInstanceId ?? matchingLane.ownerInstanceId ?? this.instanceId,
          source: "thread-title",
        });

        return {
          projectId: binding.project_id,
          route,
          parentChannelId,
          threadId: channelId,
          lane: binding.lane,
          baseBranch: binding.base_branch,
          epicId: binding.epic_id,
          assistantEnabled: Boolean(binding.assistant_enabled),
          ownerInstanceId: binding.owner_instance_id,
          source: "thread-title",
          binding,
        };
      }

      const matchingEpic = project.epicBranches.find((candidate) => {
        return candidate.id === normalizedThreadName || this.normalizeLaneIdCandidate(workstreamLaneForEpic(candidate)) === normalizedThreadName;
      });
      if (matchingEpic) {
        const binding = this.orchestrator.upsertDiscordThreadBinding({
          threadId: channelId,
          parentChannelId,
          projectId: project.id,
          epicId: matchingEpic.id,
          lane: workstreamLaneForEpic(matchingEpic),
          baseBranch: matchingEpic.branch,
          assistantEnabled: route.assistantEnabled,
          ownerInstanceId: route.ownerInstanceId ?? this.instanceId,
          source: "thread-title",
        });

        return {
          projectId: binding.project_id,
          route,
          parentChannelId,
          threadId: channelId,
          lane: binding.lane,
          baseBranch: binding.base_branch,
          epicId: binding.epic_id,
          assistantEnabled: Boolean(binding.assistant_enabled),
          ownerInstanceId: binding.owner_instance_id,
          source: "thread-title",
          binding,
        };
      }
    }

    return null;
  }

  private normalizeAssistantMessageContent(content: string): string {
    const botId = this.client.user?.id;
    if (!botId) {
      return content;
    }

    return content.replace(new RegExp(`^<@!?${botId}>\\s*`), "");
  }

  private serializeAttachments(message: Message): AssistantAttachment[] {
    return [...message.attachments.values()].map((attachment) => this.toAssistantAttachment(attachment));
  }

  private toAssistantAttachment(attachment: {
    id?: string | null;
    url?: string | null;
    proxyURL?: string | null;
    name?: string | null;
    contentType?: string | null;
    size?: number | null;
    width?: number | null;
    height?: number | null;
  }): AssistantAttachment {
    return {
      id: attachment.id ?? null,
      url: attachment.url ?? null,
      proxyUrl: attachment.proxyURL ?? null,
      name: attachment.name ?? null,
      contentType: attachment.contentType ?? null,
      size: attachment.size ?? null,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    };
  }

  private resolveWorkSmartGoalIds(
    choice: WorkSmartGoalChoice | null,
    defaults: string[]
  ): string[] {
    switch (choice) {
      case "none":
        return [];
      case "business-context":
        return ["business-context"];
      case "engineering-learning":
        return ["engineering-learning"];
      case "both":
        return ["business-context", "engineering-learning"];
      default:
        return defaults;
    }
  }

  private async resolveNotificationChannelFromWorkstreamId(
    workstreamId: string,
    purpose: "notifications" | "approvals"
  ): Promise<SendableChannel | null> {
    const workstream = this.orchestrator.getWorkstream(workstreamId);
    if (!workstream) {
      return this.resolveDefaultChannel();
    }
    return this.resolveNotificationChannel(workstream, purpose);
  }

  private async resolveNotificationChannel(
    workstream: WorkstreamRow,
    purpose: "notifications" | "approvals"
  ): Promise<SendableChannel | null> {
    const candidateIds = notificationChannelCandidateIds(
      workstream,
      this.bestRouteForProject(workstream.project_id, purpose)?.channelId,
      this.config.discord.defaultNotificationChannelId,
    );

    for (const channelId of candidateIds) {
      const channel = await this.fetchTextChannel(channelId);
      if (channel) {
        return channel;
      }
    }

    return null;
  }

  private async resolveDefaultChannel(): Promise<SendableChannel | null> {
    if (!this.config.discord.defaultNotificationChannelId) {
      return null;
    }
    return this.fetchTextChannel(this.config.discord.defaultNotificationChannelId);
  }

  private bestRouteForProject(
    projectId: string,
    purpose: "notifications" | "approvals"
  ): DiscordRoute | null {
    const routes = this.config.discord.routes.filter((route) => route.projectId === projectId);
    if (routes.length === 0) {
      return null;
    }

    return routes
      .map((route) => ({ route, score: routeScore(route, purpose) }))
      .sort((left, right) => right.score - left.score)[0]?.route ?? null;
  }

  private async fetchTextChannel(channelId: string): Promise<SendableChannel | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        return null;
      }

      if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread
      ) {
        return channel as SendableChannel;
      }

      if ("isSendable" in channel && channel.isSendable()) {
        return channel as SendableChannel;
      }

      log.warn({ channelId, type: channel.type }, "Discord channel is not sendable");
      return null;
    } catch (error) {
      if (isDiscordApiError(error, 50001)) {
        log.warn({ channelId, err: error }, "Discord bot is missing access to channel");
        return null;
      }

      if (isDiscordApiError(error, 50013)) {
        log.warn({ channelId, err: error }, "Discord bot is missing permissions to use channel");
        return null;
      }

      log.warn({ channelId, err: error }, "Failed to fetch Discord channel");
      return null;
    }
  }

  private async safeSend(
    channel: SendableChannel,
    options: string | MessageCreateOptions
  ): Promise<void> {
    try {
      if (typeof options === "string") {
        for (const chunk of splitDiscordMessageContent(options)) {
          await channel.send(chunk);
        }
        return;
      }

      if (typeof options.content === "string" && !options.files && !options.embeds) {
        const chunks = splitDiscordMessageContent(options.content);
        for (const [index, chunk] of chunks.entries()) {
          const isLastChunk = index === chunks.length - 1;
          await channel.send({
            ...options,
            content: chunk,
            components: isLastChunk ? options.components : [],
          });
        }
        return;
      }

      await channel.send(options);
    } catch (error) {
      if (isDiscordApiError(error, 50001)) {
        log.warn({ channelId: channel.id, err: error }, "Discord bot lost access before sending message");
        return;
      }

      if (isDiscordApiError(error, 50013)) {
        log.warn(
          { channelId: channel.id, err: error },
          "Discord bot lacks permission to send into channel"
        );
        return;
      }

      throw error;
    }
  }

  private async replyWithChunks(
    message: Message,
    content: string,
    options?: Omit<MessageCreateOptions, "content">
  ): Promise<void> {
    const chunks = splitDiscordMessageContent(content);
    await message.reply({
      ...(options ?? {}),
      content: chunks[0] ?? "",
    });

    for (const chunk of chunks.slice(1)) {
      await this.safeSend(message.channel as SendableChannel, {
        content: chunk,
      });
    }
  }

  private async editReplyWithChunks(
    interaction: ChatInputCommandInteraction,
    options: string | InteractionEditReplyOptions
  ): Promise<void> {
    if (typeof options === "string") {
      const chunks = splitDiscordMessageContent(options);
      await interaction.editReply(chunks[0] ?? "");
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({
          content: chunk,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (typeof options.content !== "string" || options.files || options.embeds || options.components) {
      await interaction.editReply(options);
      return;
    }

    const chunks = splitDiscordMessageContent(options.content);
    await interaction.editReply({
      ...options,
      content: chunks[0] ?? "",
    });

    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({
        content: chunk,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private buildTurnCompletedMessage(
    heading: string,
    turnId: string,
    summary?: string,
    output?: string
  ): MessageCreateOptions {
    const normalizedOutput = output?.trim() ?? "";
    const fullBody = renderMarkdownDocument({
      title: heading,
      summary: summary ? [summary] : [],
      facts: [{ label: "Turn ID", value: `\`${turnId}\`` }],
      sections: normalizedOutput
        ? [{ title: "Details", lines: normalizedOutput.split(/\r?\n/).map((line) => line || " ") }]
        : [],
    });
    return { content: fullBody };
  }

  private buildBriefGeneratedMessage(
    generatedAt: string,
    summary: string,
    markdown: string
  ): MessageCreateOptions {
    const trimmed = markdown.trim();
    const fullBody = renderMarkdownDocument({
      title: "Maverick Brief",
      summary: [summary],
      facts: [{ label: "Generated", value: generatedAt }],
      sections: [{ title: "Details", lines: trimmed.split(/\r?\n/).map((line) => line || " ") }],
    });
    return { content: fullBody };
  }

  private buildReviewCompletedMessage(
    workstreamId: string,
    severity: string,
    findings: string
  ): MessageCreateOptions {
    const trimmed = findings.trim();
    const fullBody = renderMarkdownDocument({
      title: "Post-Turn Review",
      summary: [`Severity: \`${severity}\``],
      facts: [{ label: "Workstream", value: `\`${workstreamId}\`` }],
      sections: [{ title: "Findings", lines: trimmed.split(/\r?\n/).map((line) => line || " ") }],
    });
    return { content: fullBody };
  }

  private buildReviewCommandCompletedMessage(
    workstreamId: string,
    workstreamName: string,
    reviewer: "primary" | "claude",
    severity: string,
    findings: string,
  ): MessageCreateOptions {
    const trimmed = findings.trim();
    const fullBody = renderMarkdownDocument({
      title: `Review - ${workstreamName}`,
      summary: [`Reviewer: \`${reviewer}\``, `Severity: \`${severity}\``],
      facts: [{ label: "Workstream", value: `\`${workstreamId}\`` }],
      sections: [{ title: "Findings", lines: trimmed.split(/\r?\n/).map((line) => line || " ") }],
    });
    return { content: fullBody };
  }

  private buildVerificationCompletedMessage(
    workstreamId: string,
    status: string,
    recommendation: string,
    renderedVerification: string
  ): MessageCreateOptions {
    const trimmed = renderedVerification.trim();
    const fullBody = renderMarkdownDocument({
      title: "Verification Report",
      summary: [`Status: \`${status}\``, `Recommendation: \`${recommendation}\``],
      facts: [{ label: "Workstream", value: `\`${workstreamId}\`` }],
      sections: [{ title: "Evidence", lines: trimmed.split(/\r?\n/).map((line) => line || " ") }],
    });
    return { content: fullBody };
  }

  private appendStatusFooter(
    options: MessageCreateOptions,
    workstreamId: string,
  ): MessageCreateOptions {
    const snapshot = this.orchestrator.getWorkstreamStatusSnapshot(workstreamId);
    if (!snapshot) {
      return options;
    }

    const baseContent = typeof options.content === "string" ? options.content : "";
    const footerSection = [
      "## Workstream Health",
      `- Health: \`${snapshot.health}\``,
      snapshot.latestReport ? `- Latest report: ${snapshot.latestReport.headline}` : null,
      `- Next action: ${snapshot.nextAction}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const combined = [baseContent, footerSection].filter(Boolean).join("\n\n");
    return {
      ...options,
      content: combined,
    };
  }

  private runBackgroundTask(context: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      log.warn({ err: error, context }, "Discord background task failed");
    });
  }
}
