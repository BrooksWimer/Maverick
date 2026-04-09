import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OrchestratorConfig } from "../config/schema.js";
import {
  approvals,
  assistantCalendarEvents,
  assistantNotes,
  assistantReminders,
  turns,
  workstreams,
} from "../state/index.js";
import type {
  AssistantNoteSummary,
  BriefContext,
  CalendarEventSummary,
  GitStatusSnapshot,
  ProjectApprovalSummary,
  ProjectBriefContext,
  ReminderSummary,
  WorkstreamBriefSummary,
} from "./types.js";

const execFileAsync = promisify(execFile);

type GitRunner = (args: string[], cwd: string) => Promise<string>;

function parseTags(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function normalizeNote(note: import("../state/index.js").AssistantNoteRow): AssistantNoteSummary {
  return {
    title: note.title,
    content: note.content,
    tags: parseTags(note.tags_json),
    createdAt: note.created_at,
  };
}

function normalizeReminder(reminder: import("../state/index.js").AssistantReminderRow): ReminderSummary {
  return {
    body: reminder.body,
    remindAt: reminder.remind_at,
    channel: reminder.channel,
    destination: reminder.destination,
    status: reminder.status,
  };
}

function normalizeCalendarEvent(
  event: import("../state/index.js").AssistantCalendarEventRow
): CalendarEventSummary {
  return {
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    location: event.location,
    provider: event.provider,
    syncStatus: event.sync_status,
  };
}

export function parseGitStatus(statusOutput: string, recentCommits: string[], error?: string): GitStatusSnapshot {
  const lines = statusOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const branchLine = lines.find((line) => line.startsWith("## ")) ?? null;
  const dirtyLines = lines.filter((line) => !line.startsWith("## "));

  let branch: string | null = null;
  let trackingBranch: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (branchLine) {
    const [branchPart, trackingPart] = branchLine.slice(3).split("...");
    branch = branchPart ?? null;

    if (trackingPart) {
      const [tracking, detail] = trackingPart.split(" [");
      trackingBranch = tracking ?? null;
      if (detail) {
        const normalizedDetail = detail.replace("]", "");
        const aheadMatch = normalizedDetail.match(/ahead (\d+)/);
        const behindMatch = normalizedDetail.match(/behind (\d+)/);
        ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
        behind = behindMatch ? Number(behindMatch[1]) : 0;
      }
    }
  }

  return {
    branch,
    trackingBranch,
    ahead,
    behind,
    dirty: dirtyLines.length > 0,
    statusLines: dirtyLines,
    recentCommits,
    error,
  };
}

async function defaultGitRunner(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

export class BriefCollector {
  private readonly now: Date;
  private readonly since: Date;
  private readonly gitRunner: GitRunner;

  constructor(
    private readonly config: OrchestratorConfig,
    options?: {
      now?: Date;
      windowHours?: number;
      gitRunner?: GitRunner;
    }
  ) {
    this.now = options?.now ?? new Date();
    this.since = new Date(this.now.getTime() - (options?.windowHours ?? 24) * 60 * 60 * 1000);
    this.gitRunner = options?.gitRunner ?? defaultGitRunner;
  }

  async collect(): Promise<BriefContext> {
    const projectIds = new Set(this.config.projects.map((project) => project.id));
    const noteRows = assistantNotes.listRecent(30).map(normalizeNote);
    const reminderRows = assistantReminders
      .listRecent(30)
      .filter((reminder) => reminder.status === "scheduled")
      .map(normalizeReminder);
    const calendarRows = assistantCalendarEvents
      .listRecent(20)
      .filter((event) => event.starts_at >= this.since.toISOString())
      .map(normalizeCalendarEvent);
    const pendingApprovals = approvals.listPending();

    const projects = await Promise.all(
      this.config.projects.map(async (project) => {
        const projectWorkstreams = workstreams.listByProject(project.id);
        const workstreamSummaries = projectWorkstreams.map<WorkstreamBriefSummary>((workstream) => {
          const latestTurn = turns.listByWorkstream(workstream.id).slice(-1)[0] ?? null;
          return {
            id: workstream.id,
            name: workstream.name,
            state: workstream.state,
            summary: workstream.summary,
            currentGoal: workstream.current_goal,
            pendingDecision: workstream.pending_decision,
            waitingOnApproval: Boolean(workstream.waiting_on_approval),
            lastActivityAt: workstream.last_activity_at,
            latestTurn: latestTurn
              ? {
                  status: latestTurn.status,
                  instruction: latestTurn.instruction,
                  summary: latestTurn.result_summary,
                  createdAt: latestTurn.created_at,
                  completedAt: latestTurn.completed_at,
                }
              : null,
          };
        });

        const projectApprovalRows = pendingApprovals
          .filter((approval) => projectWorkstreams.some((workstream) => workstream.id === approval.workstream_id))
          .map<ProjectApprovalSummary>((approval) => {
            const workstream = projectWorkstreams.find((candidate) => candidate.id === approval.workstream_id);
            return {
              id: approval.id,
              workstreamId: approval.workstream_id,
              workstreamName: workstream?.name ?? approval.workstream_id,
              type: approval.type,
              tier: approval.tier,
              description: approval.description,
              createdAt: approval.created_at,
            };
          });

        const taggedNotes = noteRows.filter((note) => note.tags.some((tag) => tag === project.id));
        const git = await this.collectGitSnapshot(project.repoPath);

        return {
          id: project.id,
          name: project.name,
          repoPath: project.repoPath,
          git,
          workstreams: workstreamSummaries,
          pendingApprovals: projectApprovalRows,
          taggedNotes,
        } satisfies ProjectBriefContext;
      })
    );

    const generalNotes = noteRows.filter((note) => !note.tags.some((tag) => projectIds.has(tag)));

    return {
      generatedAt: this.now.toISOString(),
      since: this.since.toISOString(),
      projects,
      assistant: {
        generalNotes,
        upcomingReminders: reminderRows,
        upcomingCalendarEvents: calendarRows,
      },
    };
  }

  private async collectGitSnapshot(repoPath: string): Promise<GitStatusSnapshot> {
    try {
      const [statusOutput, recentCommitsOutput] = await Promise.all([
        this.gitRunner(["status", "--short", "--branch"], repoPath),
        this.gitRunner(["log", "--oneline", `--since=${this.since.toISOString()}`, "-n", "10"], repoPath),
      ]);

      return parseGitStatus(
        statusOutput,
        recentCommitsOutput
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return parseGitStatus("", [], message);
    }
  }
}
