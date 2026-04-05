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
import type { ApprovalRow, WorkstreamRow } from "../state/index.js";
import type { DiscordRoute, OrchestratorConfig } from "../config/schema.js";

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

  return [workstream.toJSON(), project.toJSON()] satisfies RESTPostAPIApplicationCommandsJSONBody[];
}

export class DiscordBot {
  private readonly client: Client;
  private readonly commands: RESTPostAPIApplicationCommandsJSONBody[];

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly config: OrchestratorConfig,
    private readonly options: DiscordBotOptions,
    private readonly assistant: AssistantService | null = null
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

        await this.safeSend(channel, this.buildTurnCompletedMessage(heading, event.turnId, event.summary, event.output));
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
    if (!content) {
      return;
    }

    try {
      const result = await this.assistant.processIncomingMessage({
        source: "discord",
        body: content,
        from: message.author.id,
        replyTarget: message.channelId,
        metadata: {
          channelId: message.channelId,
          guildId: message.guildId,
          messageId: message.id,
          username: message.author.username,
        },
      });

      if (this.config.assistant.discord.replyInThread) {
        await message.reply({
          content: result.reply,
          allowedMentions: { repliedUser: false },
        });
      } else {
        await this.safeSend(message.channel as SendableChannel, {
          content: result.reply,
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
    const projectId =
      providedProjectId ??
      this.projectIdForChannel(interaction.channelId) ??
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

  private async handleWorkstreamStart(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.options.getString("name", true);
    const description = interaction.options.getString("description") ?? undefined;
    const projectId = this.resolveProjectId(interaction, interaction.options.getString("project"));

    const workstream = await this.orchestrator.createWorkstream({
      projectId,
      name,
      description,
      discordChannelId: interaction.channelId,
    });

    await interaction.editReply(
      [
        `Created workstream \`${workstream.name}\``,
        `ID: \`${workstream.id}\``,
        `Project: \`${projectId}\``,
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

      await interaction.editReply(this.formatWorkstream(workstream));
      return;
    }

    const current = this.orchestrator.getChannelWorkstream(interaction.channelId);
    if (current) {
      await interaction.editReply(this.formatWorkstream(current));
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
      lines.push(`- \`${workstream.id}\` ${workstream.name} [${workstream.state}]`);
    }

    await interaction.editReply(lines.join("\n"));
  }

  private async handleDispatch(interaction: ChatInputCommandInteraction): Promise<void> {
    const instruction = interaction.options.getString("instruction", true);
    const workstream = this.resolveWorkstream(interaction, interaction.options.getString("workstream"));

    const result = await this.orchestrator.dispatch(workstream.id, instruction);
    const hasLongOutput = (result.output?.length ?? 0) > DISCORD_INLINE_RESULT_LIMIT;

    await interaction.editReply({
      content: [
        `Dispatched to \`${workstream.name}\``,
        `Status: \`${result.status}\``,
        result.summary ? `Summary: ${truncate(result.summary, 1400)}` : null,
        hasLongOutput ? "Full result was posted in the thread as an attached Markdown file." : null,
      ]
        .filter(Boolean)
        .join("\n"),
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

    const result = await this.orchestrator.review(workstream.id, target);
    await interaction.editReply(
      [
        `Review for \`${workstream.name}\` completed.`,
        `Severity: \`${result.severity}\``,
        truncate(result.findings, 1500),
      ].join("\n")
    );
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

  private resolveProjectId(interaction: ChatInputCommandInteraction, explicitProjectId: string | null): string {
    if (explicitProjectId) {
      return explicitProjectId;
    }

    const routedProjectId = this.projectIdForChannel(interaction.channelId);
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
    const latestTurn = this.orchestrator.getWorkstreamTurns(workstream.id).slice(-1)[0] ?? null;

    return [
      `Workstream: \`${workstream.name}\``,
      `ID: \`${workstream.id}\``,
      `Project: \`${workstream.project_id}\``,
      `State: \`${workstream.state}\``,
      workstream.branch ? `Branch: \`${workstream.branch}\`` : "Branch: shared repository root",
      workstream.cwd ? `Workspace: \`${workstream.cwd}\`` : null,
      latestTurn ? `Latest turn: \`${latestTurn.status}\`` : null,
      workstream.current_goal ? `Current goal: ${truncate(workstream.current_goal, 1200)}` : null,
      latestTurn?.result_summary && latestTurn.status !== "completed"
        ? `Latest turn summary: ${truncate(latestTurn.result_summary, 1200)}`
        : null,
      workstream.summary ? `Summary: ${truncate(workstream.summary, 1200)}` : null,
      workstream.codex_thread_id ? `Codex thread: \`${workstream.codex_thread_id}\`` : null,
      `Waiting on approval: ${workstream.waiting_on_approval ? "yes" : "no"}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private projectIdForChannel(channelId: string): string | null {
    const route = this.config.discord.routes.find((candidate) => candidate.channelId === channelId);
    return route?.projectId ?? null;
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

  private runBackgroundTask(context: string, task: () => Promise<void>): void {
    void task().catch((error) => {
      log.warn({ err: error, context }, "Discord background task failed");
    });
  }
}
