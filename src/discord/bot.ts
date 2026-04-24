import {
  ActionRowBuilder,
  AttachmentBuilder,
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
  REST,
  Routes,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
  type TextBasedChannel,
} from "discord.js";
import { createLogger } from "../logger.js";
import { eventBus } from "../orchestrator/event-bus.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AssistantService } from "../assistant/index.js";
import type { DailyBriefService } from "../daily-brief/index.js";
import type { ApprovalRow, WorkstreamRow } from "../state/index.js";
import type { DiscordRoute, EpicBranchConfig, OrchestratorConfig, ProjectConfig } from "../config/schema.js";
import { workstreamLaneForEpic } from "../projects/epics.js";
import type { AssistantAttachment } from "../assistant/types.js";
import { buildAgendaSummary, renderAgendaMarkdown, renderInboxMarkdown, renderSearchMarkdown } from "../assistant/render.js";
import { renderWorkstreamStatusSnapshot } from "../orchestrator/status.js";

const log = createLogger("discord");

type DiscordBotOptions = {
  token: string;
  applicationId: string;
  guildId?: string;
};

const APPROVAL_PREFIX = "approval";

type SendableChannel = TextBasedChannel & {
  send: (options: string | MessageCreateOptions) => Promise<unknown>;
};

const DISCORD_INLINE_RESULT_LIMIT = 1500;
const DISCORD_STATUS_PREVIEW_LIMIT = 1500;

type ParsedEpicChoice = {
  projectId: string;
  epicId: string;
};

type ResolvedEpic = {
  id: string;
  branch: string;
  lane: string;
  source: "route" | "explicit" | "default";
};

type WorkSmartGoalChoice = "none" | "business-context" | "engineering-learning" | "both";

type AsyncWorkstreamCommand = "plan" | "answer-plan" | "dispatch" | "review" | "verify";

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

export function buildAttachedTextReply(params: {
  headerLines: string[];
  body: string;
  previewLimit?: number;
  attachmentName: string;
  attachmentNotice: string;
}): InteractionEditReplyOptions {
  const previewLimit = params.previewLimit ?? DISCORD_STATUS_PREVIEW_LIMIT;
  const inlinePreview = truncate(params.body, previewLimit);
  const inlineContent = [...params.headerLines, inlinePreview].filter(Boolean).join("\n");

  if (!shouldAttachReplyPreview(params.headerLines, params.body, previewLimit)) {
    return { content: inlineContent };
  }

  return {
    content: [...params.headerLines, params.attachmentNotice].filter(Boolean).join("\n"),
    files: [
      new AttachmentBuilder(Buffer.from(params.body, "utf8"), {
        name: params.attachmentName,
      }),
    ],
  };
}

export function shouldPostPlanGeneratedMessage(event: { needsAnswers: boolean }): boolean {
  return !event.needsAnswers;
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
  if (!epic || epic.source === "default") {
    return undefined;
  }

  return epic.id;
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
  const epicChoices = config.projects.flatMap((project) =>
    project.epicBranches.map((epic) => ({
      name: `${project.name}: ${epic.id}`,
      value: `${project.id}:${epic.id}`,
    }))
  );

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
            .setDescription("Epic lane to branch from when the route is not already pinned");
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
        .addBooleanOption((option) =>
          option
            .setName("resume")
            .setDescription("Resume the existing planning flow instead of starting a fresh one")
            .setRequired(false)
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
    );

  return [
    workstream.toJSON(),
    project.toJSON(),
    work.toJSON(),
    brief.toJSON(),
    assistant.toJSON(),
    maverick.toJSON(),
  ] satisfies RESTPostAPIApplicationCommandsJSONBody[];
}

export class DiscordBot {
  private readonly client: Client;
  private readonly commands: RESTPostAPIApplicationCommandsJSONBody[];

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
      artifactFileName,
      trigger,
    }) => {
      const channel = await this.fetchTextChannel(channelId);
      if (!channel) {
        throw new Error(`Daily brief channel ${channelId} is not accessible.`);
      }

      await this.safeSend(channel, {
        content: [
          headline,
          trigger === "scheduled" ? "Nightly brief delivered." : "Daily brief preview.",
          preview,
          "Full brief attached as a Markdown file.",
        ].join("\n\n"),
        files: [
          new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
            name: artifactFileName,
          }),
        ],
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

        await this.safeSend(
          channel,
          this.buildPlanningQuestionsMessage(workstream.name, event.instruction, event.formattedMarkdown, event.renderedPlan)
        );
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

        await this.safeSend(
          channel,
          this.buildPlanGeneratedMessage(
            workstream.name,
            event.instruction,
            event.formattedMarkdown,
            event.renderedPlan,
            event.finalExecutionPrompt,
          )
        );
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

    if (!this.isAssistantChannel(message.channelId)) {
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
        },
      });

      if (this.config.assistant.discord.replyInThread) {
        await message.reply({
          ...(result.attachment
            ? {
                content: `${result.reply}\n\nFull result attached as a Markdown file.`,
                files: [
                  new AttachmentBuilder(Buffer.from(result.attachment.content, "utf8"), {
                    name: result.attachment.name,
                  }),
                ],
              }
            : {
                content: result.reply,
              }),
          allowedMentions: { repliedUser: false },
        });
      } else {
        await this.safeSend(message.channel as SendableChannel, {
          ...(result.attachment
            ? {
                content: `${result.reply}\n\nFull result attached as a Markdown file.`,
                files: [
                  new AttachmentBuilder(Buffer.from(result.attachment.content, "utf8"), {
                    name: result.attachment.name,
                  }),
                ],
              }
            : {
                content: result.reply,
              }),
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
      case "plan":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handlePlan(interaction);
        return;
      case "answer-plan":
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.handleAnswerPlan(interaction);
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
    const projectId =
      providedProjectId ??
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
        ? `Bootstrap: ${status.bootstrap.createdFiles.length > 0 ? `installed ${status.bootstrap.createdFiles.length} file(s)` : "already present"}`
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
    await interaction.editReply({
      content: [report.headline, report.preview, `Artifact: \`${report.artifactPath}\``].join("\n\n"),
      files: [
        new AttachmentBuilder(Buffer.from(report.markdown, "utf8"), {
          name: report.artifactFileName,
        }),
      ],
    });
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
    await interaction.editReply(
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
    await interaction.editReply(
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
    await interaction.editReply(
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
    if (subcommand !== "brief") {
      await interaction.reply({
        content: `Unsupported maverick subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

    if (this.isAssistantChannel(interaction.channelId)) {
      throw new Error(
        "This channel is reserved for assistant chat. Start workstreams in the routed workstream channel instead."
      );
    }

    const route = this.resolveInteractionRoute(interaction);
    const explicitProjectId = interaction.options.getString("project");
    const explicitEpic = this.parseEpicChoice(interaction.options.getString("epic"));
    const projectId = this.resolveProjectId(
      interaction,
      explicitProjectId,
      explicitEpic?.projectId ?? null,
      route?.projectId ?? null
    );
    const epic = this.resolveEpic(projectId, route, explicitEpic);

    const workstream = await this.orchestrator.createWorkstream({
      projectId,
      name,
      description,
      discordChannelId: interaction.channelId,
      baseBranch: epic?.branch,
      lane: epic?.lane,
      epicId: persistedEpicIdForResolvedEpic(epic),
    });

    await interaction.editReply(
      [
        `Created workstream \`${workstream.name}\``,
        `ID: \`${workstream.id}\``,
        `Project: \`${projectId}\``,
        epic && epic.source !== "default" ? `Epic: \`${epic.id}\` (${epic.source})` : null,
        epic ? `Base branch: \`${epic.branch}\`${epic.source === "default" ? " (default)" : ""}` : null,
        workstream.branch ? `Branch: \`${workstream.branch}\`` : "Branch: shared repository root",
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

      await interaction.editReply(this.buildWorkstreamStatusReply(this.formatWorkstream(workstream)));
      return;
    }

    const current = this.orchestrator.getChannelWorkstream(interaction.channelId);
    if (current) {
      await interaction.editReply(this.buildWorkstreamStatusReply(this.formatWorkstream(current)));
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

    await interaction.editReply(this.buildWorkstreamStatusReply(lines.join("\n")));
  }

  private async handleDispatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const instruction = interaction.options.getString("instruction", true);
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

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

  private async handlePlan(interaction: ChatInputCommandInteraction): Promise<void> {
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));
    const instruction = interaction.options.getString("instruction", true);
    const resume = interaction.options.getBoolean("resume") ?? false;

    await this.startAsyncWorkstreamCommand(interaction, workstream, "plan", {
      description: resume
        ? "Resuming Claude planning in the background."
        : "Running Claude planning in the background.",
      run: async () => {
        await this.orchestrator.generatePlan(workstream.id, instruction, "manual", {
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

  private projectIdForChannel(channelId: string, parentChannelId?: string | null): string | null {
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
    if (!rawEpicChoice) {
      return null;
    }

    const [projectId, epicId] = rawEpicChoice.split(":", 2);
    if (!projectId || !epicId) {
      throw new Error(`Epic choice must look like "<project>:<epic>", got "${rawEpicChoice}".`);
    }

    return { projectId, epicId };
  }

  private resolveEpic(
    projectId: string,
    route: DiscordRoute | null,
    explicitEpic: ParsedEpicChoice | null
  ): ResolvedEpic | null {
    const project = this.getProjectConfig(projectId);

    if (explicitEpic && explicitEpic.projectId !== projectId) {
      throw new Error(
        `Epic selection "${explicitEpic.projectId}:${explicitEpic.epicId}" does not belong to project "${projectId}".`
      );
    }

    const epicId = explicitEpic?.epicId ?? (route?.projectId === projectId ? route.epicId : undefined);
    if (epicId) {
      const epic = project.epicBranches.find((candidate) => candidate.id === epicId);
      if (!epic) {
        throw new Error(`Project "${projectId}" does not define epic "${epicId}".`);
      }

      return {
        id: epic.id,
        branch: epic.branch,
        lane: workstreamLaneForEpic(epic),
        source: explicitEpic ? "explicit" : "route",
      };
    }

    if (project.requireEpicForWorktree) {
      throw new Error(
        `Project "${projectId}" requires an epic selection. Start the workstream in a routed epic channel or pass the epic option explicitly.`
      );
    }

    if (!project.defaultWorktreeBaseBranch) {
      return null;
    }

      return {
        id: "default",
        branch: project.defaultWorktreeBaseBranch,
        lane: project.id,
        source: "default",
      };
  }

  private resolveInteractionRoute(interaction: ChatInputCommandInteraction): DiscordRoute | null {
    return this.routeForChannel(interaction.channelId, this.parentChannelIdForInteraction(interaction));
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

  private isAssistantChannel(channelId: string): boolean {
    return this.config.assistant.enabled &&
      this.config.assistant.discord.enabled &&
      this.config.assistant.discord.channelIds.includes(channelId);
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
    const candidateIds = [
      workstream.discord_channel_id,
      this.bestRouteForProject(workstream.project_id, purpose)?.channelId,
      this.config.discord.defaultNotificationChannelId,
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

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

  private buildTurnCompletedMessage(
    heading: string,
    turnId: string,
    summary?: string,
    output?: string
  ): MessageCreateOptions {
    const normalizedOutput = output?.trim() ?? "";
    const shouldAttachOutput = normalizedOutput.length > DISCORD_INLINE_RESULT_LIMIT;

    if (shouldAttachOutput) {
      const attachment = new AttachmentBuilder(Buffer.from(normalizedOutput, "utf8"), {
        name: `maverick-turn-${turnId}.md`,
      });

      return {
        content: [
          heading,
          `Turn ID: \`${turnId}\``,
          summary ? `Summary:\n${truncate(summary, 1200)}` : null,
          "Full result attached as a Markdown file.",
        ]
          .filter(Boolean)
          .join("\n"),
        files: [attachment],
      };
    }

    return {
      content: [
        heading,
        `Turn ID: \`${turnId}\``,
        normalizedOutput ? `Result:\n${truncate(normalizedOutput, 1600)}` : null,
        !normalizedOutput && summary ? `Summary:\n${truncate(summary, 1600)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  private buildBriefGeneratedMessage(
    generatedAt: string,
    summary: string,
    markdown: string
  ): MessageCreateOptions {
    const trimmed = markdown.trim();
    if (trimmed.length > DISCORD_INLINE_RESULT_LIMIT) {
      const attachment = new AttachmentBuilder(Buffer.from(trimmed, "utf8"), {
        name: `maverick-brief-${generatedAt.replace(/[:]/g, "-")}.md`,
      });

      return {
        content: [
          "Claude generated a Maverick brief.",
          `Generated: ${generatedAt}`,
          `Summary: ${truncate(summary, 1200)}`,
          "Full brief attached as a Markdown file.",
        ].join("\n"),
        files: [attachment],
      };
    }

    return {
      content: [
        "Claude generated a Maverick brief.",
        `Generated: ${generatedAt}`,
        trimmed,
      ].join("\n"),
    };
  }

  private buildReviewCompletedMessage(
    workstreamId: string,
    severity: string,
    findings: string
  ): MessageCreateOptions {
    const trimmed = findings.trim();
    if (trimmed.length > DISCORD_INLINE_RESULT_LIMIT) {
      const attachment = new AttachmentBuilder(Buffer.from(trimmed, "utf8"), {
        name: `claude-review-${workstreamId}.md`,
      });

      return {
        content: [
          "Claude completed a post-turn review.",
          `Workstream: \`${workstreamId}\``,
          `Severity: \`${severity}\``,
          "Full review attached as a Markdown file.",
        ].join("\n"),
        files: [attachment],
      };
    }

    return {
      content: [
        "Claude completed a post-turn review.",
        `Workstream: \`${workstreamId}\``,
        `Severity: \`${severity}\``,
        trimmed,
      ].join("\n"),
    };
  }

  private buildReviewCommandCompletedMessage(
    workstreamId: string,
    workstreamName: string,
    reviewer: "primary" | "claude",
    severity: string,
    findings: string,
  ): MessageCreateOptions {
    const trimmed = findings.trim();
    const headerLines = [
      `Review for \`${workstreamName}\` completed.`,
      `Workstream: \`${workstreamId}\``,
      `Reviewer: \`${reviewer}\``,
      `Severity: \`${severity}\``,
    ];

    if (shouldAttachReplyPreview(headerLines, trimmed, 1500)) {
      return {
        content: [...headerLines, "Full review attached as a Markdown file."].join("\n"),
        files: [
          new AttachmentBuilder(Buffer.from(trimmed, "utf8"), {
            name: `review-${workstreamId}.md`,
          }),
        ],
      };
    }

    return {
      content: [...headerLines, trimmed].filter(Boolean).join("\n"),
    };
  }

  private buildVerificationCompletedMessage(
    workstreamId: string,
    status: string,
    recommendation: string,
    renderedVerification: string
  ): MessageCreateOptions {
    const trimmed = renderedVerification.trim();
    if (trimmed.length > DISCORD_INLINE_RESULT_LIMIT) {
      const attachment = new AttachmentBuilder(Buffer.from(trimmed, "utf8"), {
        name: `verification-${workstreamId}.md`,
      });

      return {
        content: [
          "Claude completed verification.",
          `Workstream: \`${workstreamId}\``,
          `Status: \`${status}\``,
          `Recommendation: \`${recommendation}\``,
          "Full verification report attached as a Markdown file.",
        ].join("\n"),
        files: [attachment],
      };
    }

    return {
      content: [
        "Claude completed verification.",
        `Workstream: \`${workstreamId}\``,
        `Status: \`${status}\``,
        `Recommendation: \`${recommendation}\``,
        trimmed,
      ].join("\n"),
    };
  }

  private buildPlanningQuestionsMessage(
    workstreamName: string,
    instruction: string,
    formattedMarkdown: string,
    renderedPlan: string,
  ): MessageCreateOptions {
    const headerLines = [
      `Planning for \`${workstreamName}\` is waiting on operator input.`,
      `Instruction: ${truncate(instruction, 500)}`,
      "Respond with `/workstream answer-plan` using one line per answer: `question-id: your answer`.",
    ];

    if (!shouldAttachReplyPreview(headerLines, formattedMarkdown, 1400)) {
      return {
        content: [...headerLines, formattedMarkdown].join("\n"),
      };
    }

    return {
      content: [...headerLines, "Full planning context attached as a Markdown file."].join("\n"),
      files: [
        new AttachmentBuilder(Buffer.from(renderedPlan, "utf8"), {
          name: "planning-questions.md",
        }),
      ],
    };
  }

  private buildPlanGeneratedMessage(
    workstreamName: string,
    instruction: string,
    formattedMarkdown: string,
    renderedPlan: string,
    finalExecutionPrompt: string | null,
  ): MessageCreateOptions {
    const headerLines = [
      `Planning for \`${workstreamName}\` is ready.`,
      `Instruction: ${truncate(instruction, 500)}`,
      finalExecutionPrompt
        ? "Dispatch with the same instruction to reuse the stored final Codex execution prompt."
        : "A structured plan was stored, but no final execution prompt is ready yet.",
    ];

    if (!shouldAttachReplyPreview(headerLines, formattedMarkdown, 1400)) {
      return {
        content: [...headerLines, formattedMarkdown].join("\n"),
      };
    }

    return {
      content: [...headerLines, "Full planning context attached as a Markdown file."].join("\n"),
      files: [
        new AttachmentBuilder(Buffer.from(renderedPlan, "utf8"), {
          name: "planning-ready.md",
        }),
      ],
    };
  }

  private buildInlineOrAttachedReply(params: {
    headerLines: string[];
    previewBody: string;
    previewLimit?: number;
    fullBody: string;
    attachmentName: string;
    attachmentNotice: string;
  }): InteractionEditReplyOptions {
    const previewLimit = params.previewLimit ?? 1500;
    const inlinePreview = truncate(params.previewBody, previewLimit);
    const inlineContent = [...params.headerLines, inlinePreview].filter(Boolean).join("\n");
    if (!shouldAttachReplyPreview(params.headerLines, params.previewBody, previewLimit)) {
      return { content: inlineContent };
    }

    return {
      content: [...params.headerLines, params.attachmentNotice].filter(Boolean).join("\n"),
      files: [
        new AttachmentBuilder(Buffer.from(params.fullBody, "utf8"), {
          name: params.attachmentName,
        }),
      ],
    };
  }

  private appendStatusFooter(
    options: MessageCreateOptions,
    workstreamId: string,
  ): MessageCreateOptions {
    const snapshot = this.orchestrator.getWorkstreamStatusSnapshot(workstreamId);
    if (!snapshot) {
      return options;
    }

    const footerLines = [
      `Health: \`${snapshot.health}\``,
      snapshot.latestReport ? `Latest report: ${snapshot.latestReport.headline}` : null,
      `Next action: ${snapshot.nextAction}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");

    const baseContent = typeof options.content === "string" ? options.content : "";
    const combined = [baseContent, footerLines].filter(Boolean).join("\n\n");
    return {
      ...options,
      content: truncate(combined, 1900),
    };
  }

  private runBackgroundTask(context: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      log.warn({ err: error, context }, "Discord background task failed");
    });
  }
}
