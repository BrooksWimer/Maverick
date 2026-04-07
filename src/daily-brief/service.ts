import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createLogger } from "../logger.js";
import type { OrchestratorConfig, ProjectConfig } from "../config/schema.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { inspectGitWorkspace, type GitWorkspaceInspection } from "../git/inspection.js";
import {
  approvals,
  assistantNotes,
  assistantReminders,
  events,
  turns,
  workstreams,
  type AssistantNoteRow,
  type AssistantReminderRow,
  type TurnRow,
  type WorkstreamRow,
} from "../state/index.js";

const log = createLogger("daily-brief");

type DailyBriefDispatcher = (params: {
  channelId: string;
  headline: string;
  preview: string;
  markdown: string;
  artifactFileName: string;
  artifactPath: string;
  dateKey: string;
  trigger: "manual" | "scheduled";
}) => Promise<void>;

type WorkspaceHealth = {
  path: string;
  label: string;
  inspection: GitWorkspaceInspection;
};

export type DailyBriefProjectSection = {
  projectId: string;
  projectName: string;
  touchedToday: boolean;
  statusLine: string;
  workedOnLines: string[];
  nextStep: string;
  blockers: string[];
  hygiene: string[];
  relatedNotes: string[];
};

export type DailyBriefReport = {
  dateKey: string;
  generatedAt: string;
  timeZone: string;
  headline: string;
  preview: string;
  markdown: string;
  artifactPath: string;
  artifactFileName: string;
  projectSections: DailyBriefProjectSection[];
};

type DailyBriefServiceOptions = {
  now?: () => Date;
  inspectWorkspace?: typeof inspectGitWorkspace;
};

export class DailyBriefService {
  private readonly now: () => Date;
  private readonly inspectWorkspace: typeof inspectGitWorkspace;
  private dispatchBrief: DailyBriefDispatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly config: OrchestratorConfig,
    options: DailyBriefServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.inspectWorkspace = options.inspectWorkspace ?? inspectGitWorkspace;
  }

  start(): void {
    if (!this.config.dailyBrief.enabled || this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.processScheduledBrief().catch((error) => {
        log.warn({ err: error }, "Daily brief sweep failed");
      });
    }, this.config.dailyBrief.pollIntervalMs);

    this.timer.unref?.();
    log.info(
      {
        pollIntervalMs: this.config.dailyBrief.pollIntervalMs,
        deliveryHour: this.config.dailyBrief.deliveryHour,
        deliveryMinute: this.config.dailyBrief.deliveryMinute,
      },
      "Daily brief scheduler started"
    );
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setDispatcher(dispatcher: DailyBriefDispatcher): void {
    this.dispatchBrief = dispatcher;
  }

  async generateReport(referenceTime = this.now()): Promise<DailyBriefReport> {
    const timeZone = this.resolveTimeZone();
    const dateKey = formatDateKey(referenceTime, timeZone);
    const generatedAt = referenceTime.toISOString();
    const projectSections = await Promise.all(
      this.config.projects
        .slice(0, this.config.dailyBrief.maxProjectsInDigest)
        .map((project) => this.buildProjectSection(project, referenceTime, dateKey, timeZone))
    );
    const recentNotes = assistantNotes
      .listRecent(100)
      .filter((note) => isSameLocalDay(note.created_at, referenceTime, timeZone))
      .slice(0, this.config.dailyBrief.maxNotesInDigest);
    const upcomingReminders = assistantReminders
      .listRecent(100)
      .filter((reminder) => reminder.status === "scheduled" && reminder.remind_at >= generatedAt)
      .slice(0, this.config.dailyBrief.maxRemindersInDigest);

    const artifactPath = this.writeArtifact(dateKey, renderDailyBriefMarkdown({
      dateKey,
      generatedAt,
      timeZone,
      projectSections,
      recentNotes,
      upcomingReminders,
      pendingApprovals: approvals.listPending().length,
    }));

    const markdown = renderDailyBriefMarkdown({
      dateKey,
      generatedAt,
      timeZone,
      projectSections,
      recentNotes,
      upcomingReminders,
      pendingApprovals: approvals.listPending().length,
    });
    const artifactFileName = basename(artifactPath);
    const preview = buildPreview({
      projectSections,
      recentNotes,
      upcomingReminders,
      pendingApprovals: approvals.listPending().length,
      timeZone,
      dateKey,
    });

    events.emit({
      event_type: "daily-brief.generated",
      payload: {
        dateKey,
        generatedAt,
        artifactPath,
        projectCount: projectSections.length,
      },
      source: "daily-brief",
    });

    return {
      dateKey,
      generatedAt,
      timeZone,
      headline: `Maverick daily brief for ${formatDateLabel(referenceTime, timeZone)}`,
      preview,
      markdown,
      artifactPath,
      artifactFileName,
      projectSections,
    };
  }

  async sendScheduledReport(referenceTime = this.now()): Promise<DailyBriefReport | null> {
    const channelId = this.resolveDeliveryChannelId();
    if (!channelId || !this.dispatchBrief) {
      log.warn({ channelId }, "Daily brief is enabled but no Discord delivery route is available");
      return null;
    }

    const report = await this.generateReport(referenceTime);
    await this.dispatchBrief({
      channelId,
      headline: report.headline,
      preview: report.preview,
      markdown: report.markdown,
      artifactFileName: report.artifactFileName,
      artifactPath: report.artifactPath,
      dateKey: report.dateKey,
      trigger: "scheduled",
    });

    events.emit({
      event_type: "daily-brief.sent",
      payload: {
        dateKey: report.dateKey,
        generatedAt: report.generatedAt,
        channelId,
        artifactPath: report.artifactPath,
        trigger: "scheduled",
      },
      source: "daily-brief",
    });

    log.info({ channelId, dateKey: report.dateKey }, "Daily brief sent");
    return report;
  }

  private async processScheduledBrief(): Promise<void> {
    const referenceTime = this.now();
    if (!this.shouldSendNow(referenceTime)) {
      return;
    }

    const dateKey = formatDateKey(referenceTime, this.resolveTimeZone());
    if (this.wasAlreadySent(dateKey)) {
      return;
    }

    await this.sendScheduledReport(referenceTime);
  }

  private shouldSendNow(referenceTime: Date): boolean {
    const parts = getTimeZoneParts(referenceTime, this.resolveTimeZone());
    if (parts.hour > this.config.dailyBrief.deliveryHour) {
      return true;
    }

    return (
      parts.hour === this.config.dailyBrief.deliveryHour &&
      parts.minute >= this.config.dailyBrief.deliveryMinute
    );
  }

  private wasAlreadySent(dateKey: string): boolean {
    return events.listByType("daily-brief.sent", 30).some((eventRow) => {
      try {
        const payload = JSON.parse(eventRow.payload_json) as { dateKey?: string };
        return payload.dateKey === dateKey;
      } catch {
        return false;
      }
    });
  }

  private resolveTimeZone(): string {
    return this.config.dailyBrief.timeZone ?? this.config.assistant.timeZone;
  }

  private resolveDeliveryChannelId(): string | null {
    return this.config.dailyBrief.channelId ??
      this.config.discord.defaultNotificationChannelId ??
      this.config.assistant.discord.channelIds[0] ??
      null;
  }

  private writeArtifact(dateKey: string, markdown: string): string {
    const artifactDirectory = resolve(process.cwd(), this.config.dailyBrief.artifactDirectory);
    mkdirSync(artifactDirectory, { recursive: true });
    const artifactPath = resolve(artifactDirectory, `${dateKey}.md`);
    writeFileSync(artifactPath, markdown, "utf8");
    return artifactPath;
  }

  private async buildProjectSection(
    project: ProjectConfig,
    referenceTime: Date,
    dateKey: string,
    timeZone: string
  ): Promise<DailyBriefProjectSection> {
    const projectWorkstreams = workstreams.listByProject(project.id);
    const touchedToday = projectWorkstreams.filter((workstream) =>
      isSameLocalDay(workstream.last_activity_at, referenceTime, timeZone)
    );
    const focus = touchedToday[0] ??
      projectWorkstreams.find((workstream) => workstream.state !== "done") ??
      projectWorkstreams[0] ??
      null;
    const workedOnLines = (touchedToday.length > 0 ? touchedToday : focus ? [focus] : [])
      .slice(0, 3)
      .map((workstream) => this.describeWorkstream(workstream, referenceTime, timeZone));
    const blockers = this.collectBlockers(projectWorkstreams);
    const workspaceHealth = await this.inspectProjectWorkspaces(project, projectWorkstreams, referenceTime, timeZone);
    const relatedNotes = this.collectRelatedNotes(project, referenceTime, timeZone);

    return {
      projectId: project.id,
      projectName: project.name,
      touchedToday: touchedToday.length > 0,
      statusLine: this.buildStatusLine(projectWorkstreams, focus, referenceTime, timeZone, touchedToday.length > 0),
      workedOnLines,
      nextStep: this.suggestNextStep(projectWorkstreams, focus),
      blockers,
      hygiene: workspaceHealth.map((workspace) => renderWorkspaceHealth(workspace, timeZone)),
      relatedNotes,
    };
  }

  private describeWorkstream(
    workstream: WorkstreamRow,
    referenceTime: Date,
    timeZone: string
  ): string {
    const workstreamTurns = turns.listByWorkstream(workstream.id);
    const latestTodayTurn = [...workstreamTurns]
      .reverse()
      .find((turn) => isTurnActiveOnLocalDay(turn, referenceTime, timeZone));
    const latestTurn = workstreamTurns[workstreamTurns.length - 1] ?? null;
    const summary = latestTodayTurn?.result_summary ??
      latestTodayTurn?.instruction ??
      workstream.summary ??
      latestTurn?.result_summary ??
      workstream.current_goal ??
      workstream.description ??
      "Updated with no summary captured yet.";

    return `${workstream.name} [${workstream.state}]: ${truncate(summary, 180)}`;
  }

  private buildStatusLine(
    projectWorkstreams: WorkstreamRow[],
    focus: WorkstreamRow | null,
    referenceTime: Date,
    timeZone: string,
    touchedToday: boolean
  ): string {
    if (touchedToday) {
      return `Worked on today across ${Math.max(
        1,
        projectWorkstreams.filter((workstream) => isSameLocalDay(workstream.last_activity_at, referenceTime, timeZone)).length
      )} workstream(s).`;
    }

    if (!focus) {
      return "No Maverick workstreams are tracking this project yet.";
    }

    const workstreamTurns = turns.listByWorkstream(focus.id);
    const latestTurn = workstreamTurns[workstreamTurns.length - 1] ?? null;
    const summary = focus.summary ??
      latestTurn?.result_summary ??
      focus.current_goal ??
      focus.description ??
      "No summary captured yet.";

    return `No new activity today. Latest update from ${formatDateTimeLabel(focus.last_activity_at, timeZone)}: ${truncate(summary, 180)}`;
  }

  private suggestNextStep(projectWorkstreams: WorkstreamRow[], focus: WorkstreamRow | null): string {
    const approvalCount = projectWorkstreams.filter((workstream) => workstream.waiting_on_approval).length;
    if (approvalCount > 0) {
      return `Resolve ${approvalCount} pending approval${approvalCount === 1 ? "" : "s"} before asking Maverick to continue.`;
    }

    const blocked = projectWorkstreams.find((workstream) => workstream.state === "blocked");
    if (blocked) {
      return `Unblock ${blocked.name}: ${truncate(blocked.current_goal ?? blocked.summary ?? "clarify what information is missing.", 180)}`;
    }

    if (!focus) {
      return "Decide whether this project needs a new workstream or can stay idle.";
    }

    if (focus.current_goal) {
      return `Continue ${focus.name}: ${truncate(focus.current_goal, 180)}`;
    }

    const latestTurn = turns.listByWorkstream(focus.id).slice(-1)[0] ?? null;
    if (latestTurn?.status === "failed" && latestTurn.result_summary) {
      return `Investigate ${focus.name}: ${truncate(latestTurn.result_summary, 180)}`;
    }

    if (focus.summary) {
      return `Resume ${focus.name}: ${truncate(focus.summary, 180)}`;
    }

    return `Review ${focus.name} and choose the next concrete implementation step.`;
  }

  private collectBlockers(projectWorkstreams: WorkstreamRow[]): string[] {
    const blockers: string[] = [];
    const blockedStreams = projectWorkstreams.filter((workstream) => workstream.state === "blocked");
    for (const workstream of blockedStreams.slice(0, 2)) {
      blockers.push(`${workstream.name} is blocked.`);
    }

    for (const workstream of projectWorkstreams) {
      if (workstream.waiting_on_approval) {
        blockers.push(`${workstream.name} is waiting on approval.`);
      }

      const latestTurn = turns.listByWorkstream(workstream.id).slice(-1)[0] ?? null;
      if (latestTurn?.status === "failed") {
        blockers.push(
          `${workstream.name} hit a failed turn${latestTurn.result_summary ? `: ${truncate(latestTurn.result_summary, 140)}` : "."}`
        );
      }
    }

    return [...new Set(blockers)].slice(0, 4);
  }

  private async inspectProjectWorkspaces(
    project: ProjectConfig,
    projectWorkstreams: WorkstreamRow[],
    referenceTime: Date,
    timeZone: string
  ): Promise<WorkspaceHealth[]> {
    const seen = new Map<string, string>();

    for (const workstream of projectWorkstreams) {
      if (!workstream.cwd) {
        continue;
      }

      if (
        workstream.state !== "done" ||
        isSameLocalDay(workstream.last_activity_at, referenceTime, timeZone)
      ) {
        seen.set(workstream.cwd, workstream.name);
      }
    }

    if (!seen.has(project.repoPath)) {
      seen.set(project.repoPath, "repo root");
    }

    const health: WorkspaceHealth[] = [];
    for (const [path, label] of seen.entries()) {
      health.push({
        path,
        label,
        inspection: await this.inspectWorkspace(path),
      });
    }

    return health;
  }

  private collectRelatedNotes(
    project: ProjectConfig,
    referenceTime: Date,
    timeZone: string
  ): string[] {
    const normalizedProjectId = normalizeLabel(project.id);
    const normalizedProjectName = normalizeLabel(project.name);

    return assistantNotes
      .listRecent(100)
      .filter((note) => isSameLocalDay(note.created_at, referenceTime, timeZone))
      .filter((note) => {
        const normalizedNoteProject = normalizeLabel(note.project_name ?? "");
        return Boolean(normalizedNoteProject) && (
          normalizedNoteProject === normalizedProjectId ||
          normalizedNoteProject === normalizedProjectName
        );
      })
      .slice(0, 3)
      .map((note) => {
        const prefix = note.note_kind ? `[${note.note_kind}] ` : "";
        return `${note.created_at}: ${prefix}${note.title}`;
      });
  }
}

function buildPreview(params: {
  projectSections: DailyBriefProjectSection[];
  recentNotes: AssistantNoteRow[];
  upcomingReminders: AssistantReminderRow[];
  pendingApprovals: number;
  timeZone: string;
  dateKey: string;
}): string {
  const workedToday = params.projectSections.filter((section) => section.touchedToday).length;
  const dirtyWorkspaceCount = params.projectSections.flatMap((section) => section.hygiene)
    .filter((line) => line.includes("dirty") || line.includes("untracked") || line.includes("ahead") || line.includes("behind"))
    .length;
  const lines = [
    `Maverick daily brief for ${params.dateKey}.`,
    `Projects with activity today: ${workedToday}/${params.projectSections.length}`,
    `Pending approvals: ${params.pendingApprovals}`,
    `Workspace hygiene alerts: ${dirtyWorkspaceCount}`,
    `Notes captured today: ${params.recentNotes.length}`,
    `Upcoming reminders: ${params.upcomingReminders.length}`,
    "",
    ...params.projectSections.slice(0, 5).map((section) =>
      `- ${section.projectName}: ${section.touchedToday ? "worked today" : "no update today"} | next: ${truncate(section.nextStep, 100)}`
    ),
  ];

  return lines.join("\n");
}

function renderDailyBriefMarkdown(params: {
  dateKey: string;
  generatedAt: string;
  timeZone: string;
  projectSections: DailyBriefProjectSection[];
  recentNotes: AssistantNoteRow[];
  upcomingReminders: AssistantReminderRow[];
  pendingApprovals: number;
}): string {
  const workedToday = params.projectSections.filter((section) => section.touchedToday).length;
  const lines = [
    `# Maverick Daily Brief - ${params.dateKey}`,
    "",
    `Generated: ${formatDateTimeLabel(params.generatedAt, params.timeZone)}`,
    `Timezone: ${params.timeZone}`,
    "",
    "## Overview",
    `- Projects reviewed: ${params.projectSections.length}`,
    `- Projects with activity today: ${workedToday}`,
    `- Pending approvals: ${params.pendingApprovals}`,
    `- Notes captured today: ${params.recentNotes.length}`,
    `- Upcoming reminders: ${params.upcomingReminders.length}`,
  ];

  for (const section of params.projectSections) {
    lines.push("", `## ${section.projectName}`, `Status: ${section.statusLine}`);

    if (section.workedOnLines.length > 0) {
      lines.push("Worked on / latest known work:");
      for (const line of section.workedOnLines) {
        lines.push(`- ${line}`);
      }
    }

    lines.push("Next:");
    lines.push(`- ${section.nextStep}`);

    if (section.blockers.length > 0) {
      lines.push("Needs attention:");
      for (const blocker of section.blockers) {
        lines.push(`- ${blocker}`);
      }
    }

    if (section.hygiene.length > 0) {
      lines.push("Hygiene:");
      for (const line of section.hygiene) {
        lines.push(`- ${line}`);
      }
    }

    if (section.relatedNotes.length > 0) {
      lines.push("Related notes:");
      for (const line of section.relatedNotes) {
        lines.push(`- ${line}`);
      }
    }
  }

  lines.push("", "## Notes Captured Today");
  if (params.recentNotes.length === 0) {
    lines.push("- No notes captured today.");
  } else {
    for (const note of params.recentNotes) {
      const parts = [
        note.note_context !== "general" ? note.note_context : null,
        note.note_kind,
        note.project_name ? `project: ${note.project_name}` : null,
      ].filter(Boolean);
      lines.push(`- ${note.created_at}: ${note.title}${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`);
    }
  }

  lines.push("", "## Upcoming Reminders");
  if (params.upcomingReminders.length === 0) {
    lines.push("- No scheduled reminders queued.");
  } else {
    for (const reminder of params.upcomingReminders) {
      lines.push(`- ${formatDateTimeLabel(reminder.remind_at, params.timeZone)}: ${reminder.body}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderWorkspaceHealth(workspace: WorkspaceHealth, timeZone: string): string {
  const inspection = workspace.inspection;
  if (!inspection.isGitRepository) {
    return `${workspace.label} is not a git repository.`;
  }

  if (inspection.error) {
    return `${workspace.label} could not be inspected cleanly: ${inspection.error}`;
  }

  const branch = inspection.branch ? ` on \`${inspection.branch}\`` : "";
  if (inspection.clean) {
    const syncBits = [
      inspection.aheadCount > 0 ? `ahead ${inspection.aheadCount}` : null,
      inspection.behindCount > 0 ? `behind ${inspection.behindCount}` : null,
    ].filter(Boolean);
    const latestCommit = inspection.latestCommit
      ? ` Latest commit: ${inspection.latestCommit.subject} (${formatDateTimeLabel(inspection.latestCommit.committedAt, timeZone)}).`
      : "";
    return `${workspace.label}${branch} is clean${syncBits.length > 0 ? ` (${syncBits.join(", ")})` : ""}.${latestCommit}`;
  }

  const parts = [
    inspection.stagedCount > 0 ? `${inspection.stagedCount} staged` : null,
    inspection.unstagedCount > 0 ? `${inspection.unstagedCount} unstaged` : null,
    inspection.untrackedCount > 0 ? `${inspection.untrackedCount} untracked` : null,
    inspection.aheadCount > 0 ? `ahead ${inspection.aheadCount}` : null,
    inspection.behindCount > 0 ? `behind ${inspection.behindCount}` : null,
  ].filter(Boolean);

  return `${workspace.label}${branch} is dirty: ${parts.join(", ")}.`;
}

function isTurnActiveOnLocalDay(turn: TurnRow, referenceTime: Date, timeZone: string): boolean {
  return [turn.created_at, turn.started_at, turn.completed_at]
    .filter((value): value is string => Boolean(value))
    .some((value) => isSameLocalDay(value, referenceTime, timeZone));
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getTimeZoneParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number.parseInt(values.year, 10),
    month: Number.parseInt(values.month, 10),
    day: Number.parseInt(values.day, 10),
    hour: Number.parseInt(values.hour, 10),
    minute: Number.parseInt(values.minute, 10),
  };
}

function formatDateKey(date: Date | string, timeZone: string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  const parts = getTimeZoneParts(value, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function isSameLocalDay(value: string, referenceTime: Date, timeZone: string): boolean {
  return formatDateKey(value, timeZone) === formatDateKey(referenceTime, timeZone);
}

function formatDateLabel(date: Date | string, timeZone: string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
  }).format(value);
}

function formatDateTimeLabel(date: Date | string, timeZone: string): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
