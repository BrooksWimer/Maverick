import type { AssistantService } from "../assistant/index.js";
import type {
  AssistantAgendaSnapshot,
  AssistantPrimaryContext,
  AssistantTaskSnapshot,
} from "../assistant/types.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type {
  OperatorReportArtifactMetadata,
  WorkstreamHealth,
  WorkstreamStatusSnapshot,
} from "../orchestrator/status.js";
import {
  artifacts,
  assistantCalendarEvents,
  assistantMessages,
  assistantNotes,
  assistantTasks,
  workstreams,
  type ArtifactRow,
  type AssistantCalendarEventRow,
  type AssistantMessageRow,
  type AssistantNoteRow,
  type AssistantTaskRow,
  type EventRow,
} from "../state/index.js";
import type {
  CommandCenterApprovalSummary,
  CommandCenterEventSummary,
  CommandCenterEvidenceLink,
  CommandCenterHealthSummary,
  CommandCenterNoteSummary,
  CommandCenterProjectCalendarEvent,
  CommandCenterProjectIntelligenceDetail,
  CommandCenterProjectIntelligenceStatus,
  CommandCenterProjectIntelligenceSummary,
  CommandCenterProjectLaneSummary,
  CommandCenterProjectSummary,
  CommandCenterProjectTask,
  CommandCenterReportSummary,
  CommandCenterSnapshot,
  CommandCenterTaskSummary,
  CommandCenterTodayCalendarEvent,
  CommandCenterTodayPlan,
  CommandCenterTodayPlanItem,
  CommandCenterUnresolvedCapture,
} from "./types.js";

const ASSISTANT_CONTEXTS: AssistantPrimaryContext[] = [
  "work",
  "personal",
  "home",
  "errands",
  "health",
  "planning",
];

const STALE_WORKSTREAM_MS = 24 * 60 * 60 * 1000;
const RECENT_ASSISTANT_ROW_LIMIT = 120;

interface SourceContext {
  messageId: string | null;
  sourceProjectId: string | null;
  laneId: string | null;
  threadId: string | null;
  body: string | null;
  intent: string | null;
  status: string | null;
  createdAt: string | null;
}

interface ProjectBucket {
  projectId: string;
  projectName: string;
  notes: CommandCenterNoteSummary[];
  tasks: CommandCenterProjectTask[];
  calendarEvents: CommandCenterProjectCalendarEvent[];
  workstreams: WorkstreamStatusSnapshot[];
  unresolvedCaptures: CommandCenterUnresolvedCapture[];
}

interface IntelligenceBuildResult {
  summaries: CommandCenterProjectIntelligenceSummary[];
  details: CommandCenterProjectIntelligenceDetail[];
  recentNotes: CommandCenterNoteSummary[];
  todayPlan: CommandCenterTodayPlan;
}

export function buildCommandCenterSnapshot(input: {
  orchestrator: Orchestrator;
  assistant?: AssistantService | null;
  now?: Date;
}): CommandCenterSnapshot {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const assistantAvailable = Boolean(input.assistant?.isEnabled());
  const assistantAgenda = assistantAvailable
    ? input.assistant!.getAgenda(undefined, now)
    : null;

  const activeRows = input.orchestrator.listActiveWorkstreams();
  const activeWorkstreams = activeRows
    .map((workstream) => input.orchestrator.getWorkstreamStatusSnapshot(workstream.id))
    .filter((snapshot): snapshot is WorkstreamStatusSnapshot => snapshot !== null);
  const activeRowsById = new Map(activeRows.map((workstream) => [workstream.id, workstream]));
  const reports = buildLatestReports();
  const pendingApprovals = input.orchestrator.getPendingApprovals().map((approval) => {
    const workstream = workstreams.getById(approval.workstream_id);
    return {
      id: approval.id,
      workstreamId: approval.workstream_id,
      workstreamName: workstream?.name ?? null,
      projectId: workstream?.project_id ?? null,
      type: approval.type,
      tier: approval.tier,
      description: approval.description,
      createdAt: approval.created_at,
    } satisfies CommandCenterApprovalSummary;
  });
  const recentEvents = input.orchestrator.getRecentEvents(20).map(toEventSummary);
  const projectSummaries = buildProjectSummaries(input.orchestrator, activeWorkstreams);
  const taskSummary = buildTaskSummary(assistantAgenda);
  const health = buildHealthSummary({
    activeWorkstreams,
    activeRowsById,
    pendingApprovalCount: pendingApprovals.length,
    assistantAvailable,
    now,
  });
  const intelligence = buildProjectIntelligence({
    orchestrator: input.orchestrator,
    assistantAvailable,
    assistantAgenda,
    activeWorkstreams,
    now,
  });

  return {
    generatedAt,
    assistantAgenda,
    taskSummary,
    todayPlan: intelligence.todayPlan,
    projectSummaries,
    projectIntelligenceSummaries: intelligence.summaries,
    activeWorkstreams,
    latestReports: reports,
    pendingApprovals,
    recentEvents,
    recentNotes: intelligence.recentNotes,
    health,
    nextAction: buildNextAction(
      health,
      assistantAgenda,
      activeWorkstreams,
      pendingApprovals.length,
      intelligence.todayPlan,
    ),
  };
}

export function buildCommandCenterProjectDetail(input: {
  orchestrator: Orchestrator;
  assistant?: AssistantService | null;
  projectId: string;
  now?: Date;
}): CommandCenterProjectIntelligenceDetail | null {
  const now = input.now ?? new Date();
  const assistantAvailable = Boolean(input.assistant?.isEnabled());
  const assistantAgenda = assistantAvailable
    ? input.assistant!.getAgenda(undefined, now)
    : null;
  const activeWorkstreams = input.orchestrator
    .listActiveWorkstreams()
    .map((workstream) => input.orchestrator.getWorkstreamStatusSnapshot(workstream.id))
    .filter((snapshot): snapshot is WorkstreamStatusSnapshot => snapshot !== null);

  const intelligence = buildProjectIntelligence({
    orchestrator: input.orchestrator,
    assistantAvailable,
    assistantAgenda,
    activeWorkstreams,
    now,
    includeProjectId: input.projectId,
  });

  return intelligence.details.find((detail) => detail.projectId === input.projectId) ?? null;
}

function buildTaskSummary(agenda: AssistantAgendaSnapshot | null): CommandCenterTaskSummary {
  const byContext = Object.fromEntries(ASSISTANT_CONTEXTS.map((context) => [context, 0])) as Record<
    AssistantPrimaryContext,
    number
  >;
  if (!agenda) {
    return {
      overdue: 0,
      dueToday: 0,
      open: 0,
      scheduled: 0,
      inbox: 0,
      totalActionable: 0,
      byContext,
    };
  }

  const uniqueTasks = new Map<string, AssistantTaskSnapshot>();
  for (const task of [
    ...agenda.overdueTasks,
    ...agenda.dueTodayTasks,
    ...agenda.openTasks,
    ...agenda.scheduledTasks,
    ...agenda.inboxTasks,
  ]) {
    uniqueTasks.set(task.id, task);
  }
  for (const task of uniqueTasks.values()) {
    byContext[task.primaryContext] += 1;
  }

  return {
    overdue: agenda.overdueTasks.length,
    dueToday: agenda.dueTodayTasks.length,
    open: agenda.openTasks.length,
    scheduled: agenda.scheduledTasks.length,
    inbox: agenda.inboxTasks.length,
    totalActionable: uniqueTasks.size,
    byContext,
  };
}

function buildProjectSummaries(
  orchestrator: Orchestrator,
  activeWorkstreams: WorkstreamStatusSnapshot[],
): CommandCenterProjectSummary[] {
  const statusByProject = new Map<string, WorkstreamStatusSnapshot[]>();
  for (const status of activeWorkstreams) {
    const bucket = statusByProject.get(status.projectId) ?? [];
    bucket.push(status);
    statusByProject.set(status.projectId, bucket);
  }

  return orchestrator.getHealthStatus().projects.map((project) => {
    const projectRows = workstreams.listByProject(project.id);
    const activeRows = projectRows.filter((row) => row.state !== "done");
    const statuses = statusByProject.get(project.id) ?? [];
    const stateCounts: Record<string, number> = {};
    for (const row of activeRows) {
      stateCounts[row.state] = (stateCounts[row.state] ?? 0) + 1;
    }
    const pendingApprovalCount = statuses.reduce(
      (total, status) => total + status.pendingApprovalCount,
      0,
    );
    const worst = worstHealth(statuses.map((status) => status.health));
    const latestActivityAt = activeRows
      .map((row) => row.last_activity_at)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

    return {
      id: project.id,
      name: project.name,
      workspaceKind: project.workspaceKind,
      repoPath: project.repoPath,
      activeWorkstreamCount: activeRows.length,
      pendingApprovalCount,
      states: stateCounts,
      health: worst ?? (pendingApprovalCount > 0 ? "attention" : "ok"),
      healthReason: summarizeProjectHealth(statuses),
      latestActivityAt,
    };
  });
}

function buildProjectIntelligence(input: {
  orchestrator: Orchestrator;
  assistantAvailable: boolean;
  assistantAgenda: AssistantAgendaSnapshot | null;
  activeWorkstreams: WorkstreamStatusSnapshot[];
  now: Date;
  includeProjectId?: string;
}): IntelligenceBuildResult {
  const projectDefinitions = input.orchestrator.getHealthStatus().projects;
  const projectNames = new Map(projectDefinitions.map((project) => [project.id, project.name]));
  const buckets = new Map<string, ProjectBucket>();
  const recentNotes: CommandCenterNoteSummary[] = [];
  const allTasks: CommandCenterProjectTask[] = [];
  const allCalendarEvents: CommandCenterProjectCalendarEvent[] = [];
  const planningNotes: CommandCenterNoteSummary[] = [];

  const getBucket = (projectId: string | null, projectName?: string | null): ProjectBucket | null => {
    if (!projectId) {
      return null;
    }
    const existing = buckets.get(projectId);
    if (existing) {
      return existing;
    }
    const bucket: ProjectBucket = {
      projectId,
      projectName: projectNames.get(projectId) ?? projectName ?? titleFromId(projectId),
      notes: [],
      tasks: [],
      calendarEvents: [],
      workstreams: [],
      unresolvedCaptures: [],
    };
    buckets.set(projectId, bucket);
    return bucket;
  };

  if (input.includeProjectId) {
    getBucket(input.includeProjectId);
  }

  for (const status of input.activeWorkstreams) {
    getBucket(status.projectId)?.workstreams.push(status);
  }

  if (input.assistantAvailable) {
    for (const note of assistantNotes.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      const source = resolveMessageSource(note.message_id);
      const summary = toNoteSummary(note, source);
      recentNotes.push(summary);
      if (summary.context === "planning") {
        planningNotes.push(summary);
      }
      getBucket(source.sourceProjectId, note.project_name)?.notes.push(summary);
    }

    for (const task of assistantTasks.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      const source = resolveMessageSource(task.message_id);
      const mapped = toProjectTask(task, source);
      allTasks.push(mapped);
      getBucket(source.sourceProjectId)?.tasks.push(mapped);
    }

    for (const event of assistantCalendarEvents.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      const source = resolveMessageSource(event.message_id);
      const mapped = toProjectCalendarEvent(event, source);
      allCalendarEvents.push(mapped);
      getBucket(source.sourceProjectId)?.calendarEvents.push(mapped);
    }

    for (const message of assistantMessages.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      if (!isUnresolvedCapture(message)) {
        continue;
      }
      const source = sourceFromMessage(message);
      getBucket(source.sourceProjectId)?.unresolvedCaptures.push(toUnresolvedCapture(message, source));
    }
  }

  const details = Array.from(buckets.values())
    .filter((bucket) => bucketHasActivity(bucket) || bucket.projectId === input.includeProjectId)
    .map((bucket) => toProjectDetail(bucket, input.now.toISOString()));
  const summaries = details
    .filter((detail) => detail.status !== "idle" || detail.projectId === input.includeProjectId)
    .map((detail) => ({
      projectId: detail.projectId,
      projectName: detail.projectName,
      generatedAt: detail.generatedAt,
      status: detail.status,
      headline: detail.headline,
      keyUpdates: detail.keyUpdates,
      actionItems: detail.actionItems,
      latestNoteAt: detail.latestNoteAt,
      activeWorkstreamCount: detail.activeWorkstreamCount,
      laneCount: detail.laneCount,
      unresolvedCaptureCount: detail.unresolvedCaptureCount,
      evidenceLinks: detail.evidenceLinks,
    } satisfies CommandCenterProjectIntelligenceSummary))
    .sort(compareProjectIntelligence);

  return {
    summaries,
    details: details.sort(compareProjectIntelligence),
    recentNotes: recentNotes.slice(0, 12),
    todayPlan: buildTodayPlan({
      agenda: input.assistantAgenda,
      tasks: allTasks,
      calendarEvents: allCalendarEvents,
      planningNotes,
      now: input.now,
    }),
  };
}

function buildTodayPlan(input: {
  agenda: AssistantAgendaSnapshot | null;
  tasks: CommandCenterProjectTask[];
  calendarEvents: CommandCenterProjectCalendarEvent[];
  planningNotes: CommandCenterNoteSummary[];
  now: Date;
}): CommandCenterTodayPlan {
  const timeZone = input.agenda?.timeZone ?? "America/New_York";
  const todayKey = formatDateKey(input.now, timeZone);
  const actionableTasks = input.tasks
    .filter((task) => !["done", "archived"].includes(task.status))
    .sort(compareTasksForPlan);
  const datedTasks = actionableTasks.filter((task) =>
    isSameDateKey(task.dueAt, todayKey, timeZone) || isSameDateKey(task.scheduledFor, todayKey, timeZone)
  );
  const dayTasks = uniquePlanItems([
    ...datedTasks.map(taskToPlanItem),
    ...actionableTasks.slice(0, 10).map(taskToPlanItem),
  ]).slice(0, 10);
  const focus = actionableTasks
    .filter((task) => task.primaryContext === "work" || task.primaryContext === "planning" || Boolean(task.sourceProjectId))
    .sort(compareFocusTasks)
    .slice(0, 6)
    .map(taskToPlanItem);
  const personal = actionableTasks
    .filter((task) => ["personal", "home", "errands", "health"].includes(task.primaryContext))
    .slice(0, 6)
    .map(taskToPlanItem);
  const todayCalendar = input.calendarEvents
    .filter((event) => isSameDateKey(event.startsAt, todayKey, timeZone))
    .sort((a, b) => compareDateStrings(a.startsAt, b.startsAt))
    .slice(0, 10)
    .map((event) => ({
      id: event.id,
      title: event.title,
      details: event.details,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timeZone: event.timeZone,
      location: event.location,
      syncStatus: event.syncStatus,
      projectId: event.sourceProjectId,
      laneId: event.laneId,
      evidenceLinks: event.evidenceLinks,
    } satisfies CommandCenterTodayCalendarEvent));
  const planningNotes = input.planningNotes.slice(0, 5);

  return {
    date: todayKey,
    timeZone,
    headline: summarizeTodayPlan(focus.length, dayTasks.length, personal.length, todayCalendar.length),
    focus,
    tasks: dayTasks,
    personal,
    calendarEvents: todayCalendar,
    planningNotes,
  };
}

function taskToPlanItem(task: CommandCenterProjectTask): CommandCenterTodayPlanItem {
  return {
    id: task.id,
    title: task.title,
    details: task.details,
    source: "task",
    projectId: task.sourceProjectId,
    laneId: task.laneId,
    dueAt: task.dueAt,
    scheduledFor: task.scheduledFor,
    status: task.status,
    evidenceLinks: task.evidenceLinks,
  };
}

function toProjectDetail(bucket: ProjectBucket, generatedAt: string): CommandCenterProjectIntelligenceDetail {
  const lanes = buildLaneSummaries(bucket);
  const keyUpdates = bucket.notes
    .sort(compareCreatedDesc)
    .map((note) => `${note.title}${note.excerpt ? `: ${note.excerpt}` : ""}`)
    .slice(0, 5);
  const actionItems = bucket.tasks
    .filter((task) => !["done", "archived"].includes(task.status))
    .sort(compareTasksForPlan)
    .map((task) => task.title)
    .concat(bucket.workstreams.map((workstream) => workstream.nextAction).filter(Boolean))
    .slice(0, 6);
  const latestNoteAt = latestDate(bucket.notes.map((note) => note.createdAt));
  const evidenceLinks = uniqueEvidenceLinks([
    ...bucket.notes.flatMap((note) => note.evidenceLinks),
    ...bucket.tasks.flatMap((task) => task.evidenceLinks),
    ...bucket.workstreams.flatMap(workstreamEvidenceLinks),
  ]).slice(0, 8);
  const status = projectStatus(bucket);

  return {
    projectId: bucket.projectId,
    projectName: bucket.projectName,
    generatedAt,
    status,
    headline: projectHeadline(bucket, actionItems, keyUpdates),
    keyUpdates,
    actionItems,
    latestNoteAt,
    activeWorkstreamCount: bucket.workstreams.length,
    laneCount: lanes.length,
    unresolvedCaptureCount: bucket.unresolvedCaptures.length,
    evidenceLinks,
    lanes,
    notes: bucket.notes.sort(compareCreatedDesc),
    tasks: bucket.tasks.sort(compareTaskRows),
    calendarEvents: bucket.calendarEvents.sort((a, b) => compareDateStrings(a.startsAt, b.startsAt)),
    workstreams: bucket.workstreams,
    unresolvedCaptures: bucket.unresolvedCaptures.sort(compareCreatedDesc),
  };
}

function buildLaneSummaries(bucket: ProjectBucket): CommandCenterProjectLaneSummary[] {
  const laneIds = new Set<string>();
  for (const note of bucket.notes) laneIds.add(note.laneId ?? "general");
  for (const task of bucket.tasks) laneIds.add(task.laneId ?? "general");
  for (const event of bucket.calendarEvents) laneIds.add(event.laneId ?? "general");
  for (const workstream of bucket.workstreams) laneIds.add(workstream.epicId ?? workstream.workstreamId);
  for (const capture of bucket.unresolvedCaptures) laneIds.add(capture.laneId ?? "general");

  return Array.from(laneIds).map((laneId) => {
    const notes = bucket.notes.filter((note) => (note.laneId ?? "general") === laneId);
    const tasks = bucket.tasks.filter((task) => (task.laneId ?? "general") === laneId);
    const calendar = bucket.calendarEvents.filter((event) => (event.laneId ?? "general") === laneId);
    const streamRows = bucket.workstreams.filter((workstream) =>
      (workstream.epicId ?? workstream.workstreamId) === laneId
    );
    const captures = bucket.unresolvedCaptures.filter((capture) => (capture.laneId ?? "general") === laneId);
    const keyUpdates = notes.map((note) => note.title).slice(0, 4);
    const actionItems = tasks
      .filter((task) => !["done", "archived"].includes(task.status))
      .map((task) => task.title)
      .concat(streamRows.map((workstream) => workstream.nextAction))
      .filter(Boolean)
      .slice(0, 5);
    const evidenceLinks = uniqueEvidenceLinks([
      ...notes.flatMap((note) => note.evidenceLinks),
      ...tasks.flatMap((task) => task.evidenceLinks),
      ...streamRows.flatMap(workstreamEvidenceLinks),
    ]).slice(0, 5);

    return {
      laneId,
      headline: actionItems[0] ?? keyUpdates[0] ?? "No recent lane action.",
      keyUpdates,
      actionItems,
      latestActivityAt: latestDate([
        ...notes.map((note) => note.createdAt),
        ...tasks.map((task) => task.updatedAt),
        ...calendar.map((event) => event.startsAt),
        ...streamRows.map((workstream) => workstream.generatedAt),
        ...captures.map((capture) => capture.createdAt),
      ]),
      noteCount: notes.length,
      taskCount: tasks.length,
      calendarEventCount: calendar.length,
      workstreamCount: streamRows.length,
      unresolvedCaptureCount: captures.length,
      evidenceLinks,
    } satisfies CommandCenterProjectLaneSummary;
  }).sort((a, b) => compareNullableDateDesc(a.latestActivityAt, b.latestActivityAt));
}

function toNoteSummary(note: AssistantNoteRow, source: SourceContext): CommandCenterNoteSummary {
  return {
    id: note.id,
    title: note.title,
    excerpt: truncate(note.content, 220),
    context: normalizeAssistantContext(note.note_context),
    kind: note.note_kind,
    projectName: note.project_name,
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    threadId: source.threadId,
    storagePath: note.storage_path,
    evidenceLinks: sourceEvidenceLinks(source, {
      noteStoragePath: note.storage_path,
      createdAt: note.created_at,
    }),
    createdAt: note.created_at,
  };
}

function toProjectTask(task: AssistantTaskRow, source: SourceContext): CommandCenterProjectTask {
  return {
    id: task.id,
    title: task.title,
    details: task.details,
    primaryContext: normalizeAssistantContext(task.primary_context),
    status: task.status,
    dueAt: task.due_at,
    scheduledFor: task.scheduled_for,
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    threadId: source.threadId,
    evidenceLinks: sourceEvidenceLinks(source, {
      createdAt: task.created_at,
    }),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

function toProjectCalendarEvent(
  event: AssistantCalendarEventRow,
  source: SourceContext,
): CommandCenterProjectCalendarEvent {
  return {
    id: event.id,
    title: event.title,
    details: event.details,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timeZone: event.timezone,
    location: event.location,
    syncStatus: event.sync_status,
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    threadId: source.threadId,
    evidenceLinks: sourceEvidenceLinks(source, {
      createdAt: event.created_at,
    }),
    createdAt: event.created_at,
  };
}

function toUnresolvedCapture(
  message: AssistantMessageRow,
  source: SourceContext,
): CommandCenterUnresolvedCapture {
  return {
    id: message.id,
    body: message.body,
    excerpt: truncate(message.body, 220),
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    threadId: source.threadId,
    status: message.status,
    intent: message.intent,
    evidenceLinks: sourceEvidenceLinks(source, {
      createdAt: message.created_at,
    }),
    createdAt: message.created_at,
  };
}

function buildLatestReports(): CommandCenterReportSummary[] {
  return artifacts
    .listRecent(20, "operator-report")
    .map(toReportSummary)
    .filter((report): report is CommandCenterReportSummary => report !== null)
    .slice(0, 12);
}

function toReportSummary(artifact: ArtifactRow): CommandCenterReportSummary | null {
  const metadata = parseOperatorReportMetadata(artifact.metadata_json);
  if (!metadata) {
    return null;
  }

  const workstream = workstreams.getById(artifact.workstream_id);
  if (!workstream) {
    return null;
  }

  return {
    artifactId: artifact.id,
    workstreamId: artifact.workstream_id,
    workstreamName: workstream.name,
    projectId: workstream.project_id,
    kind: metadata.kind,
    headline: metadata.headline,
    summary: metadata.summary,
    filesChanged: metadata.filesChanged,
    validation: metadata.validation,
    remainingRisks: metadata.remainingRisks,
    nextAction: metadata.nextAction,
    generatedAt: metadata.generatedAt,
    createdAt: artifact.created_at,
  };
}

function toEventSummary(event: EventRow): CommandCenterEventSummary {
  return {
    id: event.id,
    projectId: event.project_id,
    workstreamId: event.workstream_id,
    eventType: event.event_type,
    source: event.source,
    createdAt: event.created_at,
    payload: parseJsonRecord(event.payload_json),
  };
}

function buildHealthSummary(input: {
  activeWorkstreams: WorkstreamStatusSnapshot[];
  activeRowsById: Map<string, { last_activity_at: string }>;
  pendingApprovalCount: number;
  assistantAvailable: boolean;
  now: Date;
}): CommandCenterHealthSummary {
  const failedWorkstreamCount = input.activeWorkstreams.filter((status) => status.health === "failed").length;
  const blockedWorkstreamCount = input.activeWorkstreams.filter((status) => status.health === "blocked").length;
  const waitingOnApprovalCount = input.activeWorkstreams.filter((status) => status.waitingOnApproval).length;
  const staleWorkstreamCount = input.activeWorkstreams.filter((status) => {
    const row = input.activeRowsById.get(status.workstreamId);
    const lastActivity = row ? parseTimestamp(row.last_activity_at) : NaN;
    return Number.isFinite(lastActivity) && input.now.getTime() - lastActivity > STALE_WORKSTREAM_MS;
  }).length;

  const needsAttention =
    failedWorkstreamCount > 0 ||
    blockedWorkstreamCount > 0 ||
    waitingOnApprovalCount > 0 ||
    input.pendingApprovalCount > 0 ||
    staleWorkstreamCount > 0;
  const status = needsAttention
    ? "attention"
    : input.activeWorkstreams.length > 0
      ? "active"
      : input.assistantAvailable
        ? "ok"
        : "unavailable";

  return {
    status,
    reason: summarizeHealth({
      failedWorkstreamCount,
      blockedWorkstreamCount,
      waitingOnApprovalCount,
      staleWorkstreamCount,
      activeWorkstreamCount: input.activeWorkstreams.length,
      assistantAvailable: input.assistantAvailable,
    }),
    assistantAvailable: input.assistantAvailable,
    failedWorkstreamCount,
    blockedWorkstreamCount,
    waitingOnApprovalCount,
    staleWorkstreamCount,
  };
}

function buildNextAction(
  health: CommandCenterHealthSummary,
  agenda: AssistantAgendaSnapshot | null,
  activeWorkstreams: WorkstreamStatusSnapshot[],
  pendingApprovalCount: number,
  todayPlan: CommandCenterTodayPlan,
): string {
  if (pendingApprovalCount > 0) {
    return `Review ${pendingApprovalCount} pending approval${pendingApprovalCount === 1 ? "" : "s"}.`;
  }
  const failed = activeWorkstreams.find((status) => status.health === "failed");
  if (failed) {
    return `Unblock failed workstream "${failed.workstreamName}".`;
  }
  const blocked = activeWorkstreams.find((status) => status.health === "blocked");
  if (blocked) {
    return `Resolve blocker on "${blocked.workstreamName}".`;
  }
  if (health.staleWorkstreamCount > 0) {
    return `Review ${health.staleWorkstreamCount} stale workstream${health.staleWorkstreamCount === 1 ? "" : "s"}.`;
  }
  if (todayPlan.focus[0]) {
    return `Start with ${todayPlan.focus[0].title}.`;
  }
  if (agenda?.nextAction) {
    return agenda.nextAction;
  }
  if (activeWorkstreams.length > 0) {
    return `Continue monitoring ${activeWorkstreams.length} active workstream${activeWorkstreams.length === 1 ? "" : "s"}.`;
  }
  return "No urgent command-center items are queued.";
}

function resolveMessageSource(messageId: string | null): SourceContext {
  if (!messageId) {
    return emptySource();
  }
  const message = assistantMessages.getById(messageId);
  return message ? sourceFromMessage(message) : emptySource(messageId);
}

function sourceFromMessage(message: AssistantMessageRow): SourceContext {
  return {
    messageId: message.id,
    sourceProjectId: message.project_id,
    laneId: message.lane_id,
    threadId: message.thread_id,
    body: message.body,
    intent: message.intent,
    status: message.status,
    createdAt: message.created_at,
  };
}

function emptySource(messageId: string | null = null): SourceContext {
  return {
    messageId,
    sourceProjectId: null,
    laneId: null,
    threadId: null,
    body: null,
    intent: null,
    status: null,
    createdAt: null,
  };
}

function sourceEvidenceLinks(
  source: SourceContext,
  options: {
    noteStoragePath?: string | null;
    createdAt?: string | null;
  } = {},
): CommandCenterEvidenceLink[] {
  const links: CommandCenterEvidenceLink[] = [];
  if (source.threadId) {
    links.push({
      kind: "discord-thread",
      label: "Discord thread",
      target: `discord://thread/${source.threadId}`,
      sourceProjectId: source.sourceProjectId,
      laneId: source.laneId,
      createdAt: options.createdAt ?? source.createdAt,
    });
  }
  if (source.messageId) {
    links.push({
      kind: "assistant-message",
      label: "Assistant message",
      target: `maverick://assistant/messages/${source.messageId}`,
      sourceProjectId: source.sourceProjectId,
      laneId: source.laneId,
      createdAt: options.createdAt ?? source.createdAt,
    });
  }
  if (options.noteStoragePath) {
    links.push({
      kind: "note-file",
      label: "Stored note",
      target: options.noteStoragePath,
      sourceProjectId: source.sourceProjectId,
      laneId: source.laneId,
      createdAt: options.createdAt ?? source.createdAt,
    });
  }
  return links;
}

function workstreamEvidenceLinks(workstream: WorkstreamStatusSnapshot): CommandCenterEvidenceLink[] {
  const links: CommandCenterEvidenceLink[] = [
    {
      kind: "workstream",
      label: workstream.workstreamName,
      target: `/api/workstreams/${workstream.workstreamId}/status`,
      sourceProjectId: workstream.projectId,
      laneId: workstream.epicId,
      createdAt: workstream.generatedAt,
    },
  ];
  if (workstream.workspace) {
    links.push({
      kind: "repo-path",
      label: "Workspace",
      target: workstream.workspace,
      sourceProjectId: workstream.projectId,
      laneId: workstream.epicId,
      createdAt: workstream.generatedAt,
    });
  }
  return links;
}

function projectStatus(bucket: ProjectBucket): CommandCenterProjectIntelligenceStatus {
  const hasAttentionWorkstream = bucket.workstreams.some((workstream) =>
    ["failed", "blocked", "waiting-on-approval", "awaiting-input", "quiet"].includes(workstream.health)
  );
  const hasUnresolved = bucket.unresolvedCaptures.length > 0;
  if (hasAttentionWorkstream || hasUnresolved) {
    return "attention";
  }
  if (bucketHasActivity(bucket)) {
    return "active";
  }
  return "idle";
}

function bucketHasActivity(bucket: ProjectBucket): boolean {
  return Boolean(
    bucket.notes.length ||
    bucket.tasks.length ||
    bucket.calendarEvents.length ||
    bucket.workstreams.length ||
    bucket.unresolvedCaptures.length,
  );
}

function projectHeadline(bucket: ProjectBucket, actionItems: string[], keyUpdates: string[]): string {
  if (actionItems.length > 0) {
    return `${actionItems.length} action item${actionItems.length === 1 ? "" : "s"} queued.`;
  }
  if (bucket.workstreams.length > 0) {
    return `${bucket.workstreams.length} active workstream${bucket.workstreams.length === 1 ? "" : "s"}.`;
  }
  if (keyUpdates[0]) {
    return keyUpdates[0];
  }
  return "No recent project intelligence.";
}

function summarizeTodayPlan(focusCount: number, taskCount: number, personalCount: number, eventCount: number): string {
  const parts = [
    focusCount > 0 ? `${focusCount} focus item${focusCount === 1 ? "" : "s"}` : "",
    taskCount > 0 ? `${taskCount} task${taskCount === 1 ? "" : "s"}` : "",
    personalCount > 0 ? `${personalCount} personal item${personalCount === 1 ? "" : "s"}` : "",
    eventCount > 0 ? `${eventCount} calendar event${eventCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No dated plan items are queued.";
}

function isUnresolvedCapture(message: AssistantMessageRow): boolean {
  return message.direction === "inbound" && message.status !== "processed";
}

function worstHealth(values: WorkstreamHealth[]): WorkstreamHealth | null {
  const priority: WorkstreamHealth[] = [
    "failed",
    "blocked",
    "waiting-on-approval",
    "awaiting-input",
    "quiet",
    "running",
    "ready-for-review",
    "idle",
    "done",
  ];
  return priority.find((health) => values.includes(health)) ?? null;
}

function summarizeProjectHealth(statuses: WorkstreamStatusSnapshot[]): string | null {
  const attention = statuses.find((status) =>
    ["failed", "blocked", "waiting-on-approval", "awaiting-input", "quiet"].includes(status.health)
  );
  return attention?.healthReason ?? (statuses.length > 0 ? `${statuses.length} active workstream(s).` : null);
}

function summarizeHealth(input: {
  failedWorkstreamCount: number;
  blockedWorkstreamCount: number;
  waitingOnApprovalCount: number;
  staleWorkstreamCount: number;
  activeWorkstreamCount: number;
  assistantAvailable: boolean;
}): string {
  if (input.failedWorkstreamCount > 0) {
    return `${input.failedWorkstreamCount} workstream(s) need failure triage.`;
  }
  if (input.blockedWorkstreamCount > 0) {
    return `${input.blockedWorkstreamCount} workstream(s) are blocked.`;
  }
  if (input.waitingOnApprovalCount > 0) {
    return `${input.waitingOnApprovalCount} workstream(s) are waiting on approval.`;
  }
  if (input.staleWorkstreamCount > 0) {
    return `${input.staleWorkstreamCount} workstream(s) have been quiet for more than 24 hours.`;
  }
  if (input.activeWorkstreamCount > 0) {
    return `${input.activeWorkstreamCount} workstream(s) are active.`;
  }
  if (!input.assistantAvailable) {
    return "Assistant data is unavailable; showing orchestration state only.";
  }
  return "Command Center is clear.";
}

function parseOperatorReportMetadata(raw: string | null): OperatorReportArtifactMetadata | null {
  const value = parseJsonRecord(raw);
  const kind = value.kind;
  if (kind !== "plan" && kind !== "dispatch" && kind !== "verification" && kind !== "review") {
    return null;
  }

  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : 1,
    kind,
    headline: asString(value.headline) || "Operator report",
    summary: asString(value.summary),
    filesChanged: asStringArray(value.filesChanged),
    validation: Array.isArray(value.validation)
      ? value.validation
          .map((entry) => parseValidationEvidence(entry))
          .filter((entry): entry is OperatorReportArtifactMetadata["validation"][number] => entry !== null)
      : [],
    remainingRisks: asStringArray(value.remainingRisks),
    nextAction: asString(value.nextAction),
    sourceEvent: asString(value.sourceEvent),
    generatedAt: asString(value.generatedAt),
    turnId: typeof value.turnId === "string" ? value.turnId : null,
  };
}

function parseValidationEvidence(value: unknown): OperatorReportArtifactMetadata["validation"][number] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "pass" && status !== "fail" && status !== "warning" && status !== "info" && status !== "skipped") {
    return null;
  }
  return {
    label: asString(record.label) || "Validation",
    status,
    detail: asString(record.detail),
    command: asString(record.command) || undefined,
  };
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeAssistantContext(value: string | null | undefined): AssistantPrimaryContext {
  return ASSISTANT_CONTEXTS.includes(value as AssistantPrimaryContext)
    ? value as AssistantPrimaryContext
    : "personal";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function titleFromId(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ") || value;
}

function compareProjectIntelligence(
  a: CommandCenterProjectIntelligenceSummary,
  b: CommandCenterProjectIntelligenceSummary,
): number {
  const statusScore = (value: CommandCenterProjectIntelligenceStatus) =>
    value === "attention" ? 0 : value === "active" ? 1 : 2;
  const score = statusScore(a.status) - statusScore(b.status);
  if (score !== 0) {
    return score;
  }
  return compareNullableDateDesc(a.latestNoteAt, b.latestNoteAt);
}

function compareTasksForPlan(a: CommandCenterProjectTask, b: CommandCenterProjectTask): number {
  const statusRank = (status: string) => status === "overdue" ? 0 : status === "open" ? 1 : status === "inbox" ? 2 : 3;
  const rank = statusRank(a.status) - statusRank(b.status);
  if (rank !== 0) {
    return rank;
  }
  return compareNullableDateDesc(a.updatedAt, b.updatedAt);
}

function compareFocusTasks(a: CommandCenterProjectTask, b: CommandCenterProjectTask): number {
  return focusScore(b) - focusScore(a) || compareTasksForPlan(a, b);
}

function focusScore(task: CommandCenterProjectTask): number {
  const text = `${task.title} ${task.details}`.toLowerCase();
  return [
    task.status === "open" ? 3 : 0,
    task.sourceProjectId ? 2 : 0,
    text.includes("focus") ? 4 : 0,
    text.includes("astra") ? 4 : 0,
    text.includes("resume") ? 3 : 0,
    text.includes("upload") ? 2 : 0,
    text.includes("blocked") ? 2 : 0,
  ].reduce((total, score) => total + score, 0);
}

function compareTaskRows(a: CommandCenterProjectTask, b: CommandCenterProjectTask): number {
  return compareTasksForPlan(a, b) || a.title.localeCompare(b.title);
}

function compareCreatedDesc<T extends { createdAt: string }>(a: T, b: T): number {
  return compareNullableDateDesc(a.createdAt, b.createdAt);
}

function compareNullableDateDesc(a: string | null, b: string | null): number {
  return compareDateStrings(b, a);
}

function compareDateStrings(a: string | null, b: string | null): number {
  return parseTimestamp(a) - parseTimestamp(b);
}

function latestDate(values: Array<string | null>): string | null {
  const present = values.filter((value): value is string => Boolean(value));
  if (present.length === 0) {
    return null;
  }
  return present.sort((a, b) => compareDateStrings(a, b)).at(-1) ?? null;
}

function uniquePlanItems(items: CommandCenterTodayPlanItem[]): CommandCenterTodayPlanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
}

function uniqueEvidenceLinks(links: CommandCenterEvidenceLink[]): CommandCenterEvidenceLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.kind}:${link.target}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatDateKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}

function isSameDateKey(value: string | null, dateKey: string, timeZone: string): boolean {
  if (!value) {
    return false;
  }
  const parsed = new Date(normalizeDateString(value));
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return formatDateKey(parsed, timeZone) === dateKey;
}

function parseTimestamp(value: string | null): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(normalizeDateString(value));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function normalizeDateString(value: string): string {
  if (value.includes("T")) {
    return value;
  }
  return `${value.replace(" ", "T")}Z`;
}
