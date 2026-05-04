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
  assistantItemAssignments,
  assistantMessages,
  assistantNotes,
  assistantTasks,
  dashboardPlanItems,
  events,
  workstreams,
  type ArtifactRow,
  type AssistantCalendarEventRow,
  type AssistantItemAssignmentRow,
  type AssistantMessageRow,
  type AssistantNoteRow,
  type AssistantTaskRow,
  type DashboardPlanItemRow,
  type EventRow,
} from "../state/index.js";
import type {
  CommandCenterApprovalSummary,
  CommandCenterDashboardItemType,
  CommandCenterEventSummary,
  CommandCenterEvidenceLink,
  CommandCenterHealthSummary,
  CommandCenterNoteSummary,
  CommandCenterOrganizationOption,
  CommandCenterPlanBoard,
  CommandCenterPlanBoardItem,
  CommandCenterPlanSection,
  CommandCenterProjectCalendarEvent,
  CommandCenterProjectIntelligenceDetail,
  CommandCenterProjectIntelligenceStatus,
  CommandCenterProjectIntelligenceSummary,
  CommandCenterProjectLaneSummary,
  CommandCenterProjectSummary,
  CommandCenterProjectTab,
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
const PLAN_SECTIONS: CommandCenterPlanSection[] = ["focus", "next", "later", "waiting"];
const DASHBOARD_ITEM_TYPES: CommandCenterDashboardItemType[] = [
  "task",
  "note",
  "capture",
  "calendar",
  "workstream",
  "plan",
];

type AssignmentMap = Map<string, AssistantItemAssignmentRow>;

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

export interface DashboardTaskPatch {
  title?: string;
  details?: string;
  primaryContext?: AssistantPrimaryContext;
  status?: string;
  dueAt?: string | null;
  scheduledFor?: string | null;
}

export interface DashboardAssignmentPatch {
  itemType: CommandCenterDashboardItemType;
  itemId: string;
  projectId: string;
  laneId?: string | null;
  updatedBy?: string;
}

export interface DashboardPlanItemInput {
  date?: string;
  section: CommandCenterPlanSection;
  title?: string;
  details?: string | null;
  itemType?: CommandCenterDashboardItemType | null;
  itemId?: string | null;
  projectId?: string | null;
  laneId?: string | null;
  position?: number;
  status?: string;
}

export interface DashboardPlanItemPatch {
  date?: string;
  section?: CommandCenterPlanSection;
  title?: string;
  details?: string | null;
  itemType?: CommandCenterDashboardItemType | null;
  itemId?: string | null;
  projectId?: string | null;
  laneId?: string | null;
  position?: number;
  status?: string;
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
  const organizationOptions = buildOrganizationOptions(input.orchestrator, activeWorkstreams);
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
    projectTabs: buildProjectTabs(projectSummaries, intelligence.summaries),
    organizationOptions,
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

export async function completeDashboardTask(input: {
  assistant?: AssistantService | null;
  taskId: string;
}) {
  const task = assistantTasks.getById(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const completed = input.assistant?.isEnabled()
    ? await input.assistant.completeTask(input.taskId)
    : assistantTasks.update(input.taskId, {
        status: "done",
        completed_at: new Date().toISOString(),
      });

  events.emit({
    event_type: "dashboard.task.completed",
    payload: {
      taskId: input.taskId,
    },
    source: "dashboard",
  });

  return completed;
}

export function updateDashboardTask(input: {
  taskId: string;
  patch: DashboardTaskPatch;
}) {
  const task = assistantTasks.getById(input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const fields: Parameters<typeof assistantTasks.update>[1] = {};
  if (input.patch.title !== undefined) fields.title = requireNonBlank(input.patch.title, "title");
  if (input.patch.details !== undefined) fields.details = input.patch.details;
  if (input.patch.primaryContext !== undefined) fields.primary_context = normalizeAssistantContext(input.patch.primaryContext);
  if (input.patch.status !== undefined) fields.status = requireNonBlank(input.patch.status, "status");
  if (input.patch.dueAt !== undefined) fields.due_at = input.patch.dueAt;
  if (input.patch.scheduledFor !== undefined) fields.scheduled_for = input.patch.scheduledFor;
  if (fields.status && fields.status !== "done") fields.completed_at = null;
  if (fields.status === "done") fields.completed_at = new Date().toISOString();

  const updated = assistantTasks.update(input.taskId, fields);
  events.emit({
    event_type: "dashboard.task.updated",
    payload: {
      taskId: input.taskId,
      fields: Object.keys(fields),
    },
    source: "dashboard",
  });
  return updated;
}

export function assignDashboardItem(input: {
  orchestrator: Orchestrator;
  patch: DashboardAssignmentPatch;
}) {
  const itemType = normalizeDashboardItemType(input.patch.itemType);
  if (!itemType || itemType === "plan") {
    throw new Error(`Invalid dashboard item type: ${input.patch.itemType}`);
  }
  assertDashboardItemExists(itemType, input.patch.itemId);
  assertValidAssignment(input.orchestrator, input.patch.projectId, input.patch.laneId ?? null);

  const assignment = assistantItemAssignments.upsert({
    item_type: itemType,
    item_id: input.patch.itemId,
    project_id: input.patch.projectId,
    lane_id: normalizeLaneId(input.patch.laneId),
    updated_by: input.patch.updatedBy ?? "dashboard",
  });
  events.emit({
    project_id: assignment.project_id,
    event_type: "dashboard.item.assigned",
    payload: {
      itemType,
      itemId: assignment.item_id,
      projectId: assignment.project_id,
      laneId: assignment.lane_id,
    },
    source: "dashboard",
  });
  return assignment;
}

export function promoteDashboardNoteToTask(input: {
  orchestrator: Orchestrator;
  noteId: string;
}) {
  const note = assistantNotes.getById(input.noteId);
  if (!note) {
    throw new Error(`Note not found: ${input.noteId}`);
  }
  const source = resolveMessageSource(note.message_id);
  const assignment = assistantItemAssignments.get("note", note.id);
  if (assignment) {
    assertValidAssignment(input.orchestrator, assignment.project_id, assignment.lane_id);
  }

  const task = assistantTasks.create({
    message_id: note.message_id,
    source_contact: note.source_contact,
    title: note.title,
    details: note.content,
    primary_context: normalizeAssistantContext(note.note_context),
    status: "open",
    note_id: note.id,
  });
  if (assignment) {
    assistantItemAssignments.upsert({
      item_type: "task",
      item_id: task.id,
      project_id: assignment.project_id,
      lane_id: assignment.lane_id,
      updated_by: assignment.updated_by,
    });
  }

  events.emit({
    project_id: assignment?.project_id ?? source.sourceProjectId ?? undefined,
    event_type: "dashboard.note.promoted_to_task",
    payload: {
      noteId: note.id,
      taskId: task.id,
    },
    source: "dashboard",
  });
  return task;
}

export function promoteDashboardCaptureToTask(input: {
  orchestrator: Orchestrator;
  messageId: string;
}) {
  const message = assistantMessages.getById(input.messageId);
  if (!message) {
    throw new Error(`Capture not found: ${input.messageId}`);
  }
  const assignment = assistantItemAssignments.get("capture", message.id);
  if (assignment) {
    assertValidAssignment(input.orchestrator, assignment.project_id, assignment.lane_id);
  }

  const task = assistantTasks.create({
    message_id: message.id,
    source_contact: message.contact,
    title: summarizeDashboardTaskTitle(message.body),
    details: message.body,
    primary_context: message.project_id || assignment?.project_id ? "work" : "personal",
    status: "inbox",
  });
  if (assignment) {
    assistantItemAssignments.upsert({
      item_type: "task",
      item_id: task.id,
      project_id: assignment.project_id,
      lane_id: assignment.lane_id,
      updated_by: assignment.updated_by,
    });
  }

  events.emit({
    project_id: assignment?.project_id ?? message.project_id ?? undefined,
    event_type: "dashboard.capture.promoted_to_task",
    payload: {
      messageId: message.id,
      taskId: task.id,
    },
    source: "dashboard",
  });
  return task;
}

export function createDashboardTodayPlanItem(input: {
  orchestrator: Orchestrator;
  item: DashboardPlanItemInput;
  timeZone?: string;
  now?: Date;
}) {
  const date = input.item.date ?? formatDateKey(input.now ?? new Date(), input.timeZone ?? "America/New_York");
  const section = requirePlanSection(input.item.section);
  const defaults = resolvePlanItemDefaults(input.item.itemType ?? null, input.item.itemId ?? null);
  const projectId = input.item.projectId ?? defaults.projectId;
  const laneId = normalizeLaneId(input.item.laneId ?? defaults.laneId);
  if (projectId) {
    assertValidAssignment(input.orchestrator, projectId, laneId);
  }

  const row = dashboardPlanItems.create({
    date_key: date,
    section,
    item_type: input.item.itemType ?? defaults.itemType,
    item_id: input.item.itemId ?? defaults.itemId,
    title: requireNonBlank(input.item.title ?? defaults.title, "title"),
    details: input.item.details ?? defaults.details,
    project_id: projectId,
    lane_id: laneId,
    position: input.item.position ?? nextPlanPosition(date, section),
    status: input.item.status ?? "active",
  });
  events.emit({
    project_id: row.project_id ?? undefined,
    event_type: "dashboard.plan.updated",
    payload: {
      action: "created",
      itemId: row.id,
      date: row.date_key,
      section: row.section,
    },
    source: "dashboard",
  });
  return toPlanBoardItem(row, section);
}

export function updateDashboardTodayPlanItem(input: {
  orchestrator: Orchestrator;
  itemId: string;
  patch: DashboardPlanItemPatch;
}) {
  const existing = dashboardPlanItems.getById(input.itemId);
  if (!existing) {
    throw new Error(`Plan item not found: ${input.itemId}`);
  }
  const section = input.patch.section ? requirePlanSection(input.patch.section) : undefined;
  const itemType = input.patch.itemType === undefined
    ? undefined
    : normalizeDashboardItemType(input.patch.itemType);
  if (input.patch.itemType !== undefined && input.patch.itemType !== null && !itemType) {
    throw new Error(`Invalid dashboard item type: ${input.patch.itemType}`);
  }
  const nextProjectId = input.patch.projectId !== undefined ? input.patch.projectId : existing.project_id;
  const nextLaneId = input.patch.laneId !== undefined ? normalizeLaneId(input.patch.laneId) : existing.lane_id;
  if (nextProjectId) {
    assertValidAssignment(input.orchestrator, nextProjectId, nextLaneId);
  }

  const updated = dashboardPlanItems.update(input.itemId, {
    date_key: input.patch.date,
    section,
    item_type: input.patch.itemType === null ? null : itemType,
    item_id: input.patch.itemId,
    title: input.patch.title === undefined ? undefined : requireNonBlank(input.patch.title, "title"),
    details: input.patch.details,
    project_id: input.patch.projectId,
    lane_id: input.patch.laneId === undefined ? undefined : normalizeLaneId(input.patch.laneId),
    position: input.patch.position,
    status: input.patch.status,
  });
  events.emit({
    project_id: updated?.project_id ?? undefined,
    event_type: "dashboard.plan.updated",
    payload: {
      action: "updated",
      itemId: input.itemId,
      fields: Object.keys(input.patch),
    },
    source: "dashboard",
  });
  return updated ? toPlanBoardItem(updated, requirePlanSection(updated.section)) : null;
}

export function deleteDashboardTodayPlanItem(itemId: string) {
  const existing = dashboardPlanItems.getById(itemId);
  if (!existing) {
    throw new Error(`Plan item not found: ${itemId}`);
  }
  dashboardPlanItems.delete(itemId);
  events.emit({
    project_id: existing.project_id ?? undefined,
    event_type: "dashboard.plan.updated",
    payload: {
      action: "deleted",
      itemId,
      date: existing.date_key,
      section: existing.section,
    },
    source: "dashboard",
  });
  return { ok: true };
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

function buildProjectTabs(
  projectSummaries: CommandCenterProjectSummary[],
  intelligenceSummaries: CommandCenterProjectIntelligenceSummary[],
): CommandCenterProjectTab[] {
  const intelligenceByProject = new Map(intelligenceSummaries.map((summary) => [summary.projectId, summary]));
  return projectSummaries.map((project) => {
    const intelligence = intelligenceByProject.get(project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      status: intelligence?.status ?? (project.activeWorkstreamCount > 0 ? "active" : "idle"),
      headline: intelligence?.headline ?? project.healthReason ?? "No recent project activity.",
      activeWorkstreamCount: project.activeWorkstreamCount,
      actionItemCount: intelligence?.actionItems.length ?? 0,
      laneCount: intelligence?.laneCount ?? 0,
      latestActivityAt: intelligence?.latestNoteAt ?? project.latestActivityAt,
    };
  });
}

function buildOrganizationOptions(
  orchestrator: Orchestrator,
  activeWorkstreams: WorkstreamStatusSnapshot[],
): CommandCenterOrganizationOption[] {
  const projects = orchestrator.getHealthStatus().projects;
  const namesByProject = new Map(projects.map((project) => [project.id, project.name]));
  const lanesByProject = new Map<string, Map<string, CommandCenterOrganizationOption["lanes"][number]>>();

  const ensureProject = (projectId: string) => {
    if (!lanesByProject.has(projectId)) {
      lanesByProject.set(projectId, new Map());
    }
    return lanesByProject.get(projectId)!;
  };
  const addLane = (option: CommandCenterOrganizationOption["lanes"][number]) => {
    const laneId = option.laneId || "general";
    const lanes = ensureProject(option.projectId);
    const existing = lanes.get(laneId);
    if (existing) {
      lanes.set(laneId, {
        ...existing,
        ...option,
        label: existing.label || option.label,
        source: existing.source === "general" ? option.source : existing.source,
        channelId: existing.channelId ?? option.channelId,
        threadId: existing.threadId ?? option.threadId,
        epicId: existing.epicId ?? option.epicId,
        baseBranch: existing.baseBranch ?? option.baseBranch,
        assistantEnabled: existing.assistantEnabled ?? option.assistantEnabled,
      });
      return;
    }
    lanes.set(laneId, { ...option, laneId });
  };

  for (const project of projects) {
    addLane({
      projectId: project.id,
      laneId: "general",
      label: "General",
      source: "general",
      channelId: null,
      threadId: null,
      epicId: null,
      baseBranch: null,
      assistantEnabled: null,
    });
  }

  const audit = orchestrator.getAuditReport("discord") as {
    projects?: Array<{
      id: string;
      name: string;
      defaultLanes?: Array<{ id: string; baseBranch?: string; assistantEnabled?: boolean }>;
      epicBranches?: Array<{ id: string; branch?: string }>;
      threadBindings?: Array<{
        threadId: string;
        parentChannelId?: string;
        epicId?: string | null;
        lane?: string | null;
        baseBranch?: string | null;
        assistantEnabled?: boolean;
      }>;
    }>;
    discord?: {
      routes?: Array<{
        projectId: string;
        channelId: string;
        epicId?: string | null;
        lane?: string | null;
        baseBranch?: string | null;
        assistantEnabled?: boolean;
      }>;
    } | null;
  };

  for (const project of audit.projects ?? []) {
    namesByProject.set(project.id, project.name);
    for (const lane of project.defaultLanes ?? []) {
      addLane({
        projectId: project.id,
        laneId: lane.id,
        label: titleFromId(lane.id),
        source: "lane",
        channelId: null,
        threadId: null,
        epicId: null,
        baseBranch: lane.baseBranch ?? null,
        assistantEnabled: lane.assistantEnabled ?? null,
      });
    }
    for (const epic of project.epicBranches ?? []) {
      addLane({
        projectId: project.id,
        laneId: epic.id,
        label: titleFromId(epic.id),
        source: "epic",
        channelId: null,
        threadId: null,
        epicId: epic.id,
        baseBranch: epic.branch ?? null,
        assistantEnabled: null,
      });
    }
    for (const binding of project.threadBindings ?? []) {
      const laneId = binding.lane ?? binding.epicId ?? "general";
      addLane({
        projectId: project.id,
        laneId,
        label: laneId === "general" ? "General" : titleFromId(laneId),
        source: "thread",
        channelId: binding.parentChannelId ?? null,
        threadId: binding.threadId,
        epicId: binding.epicId ?? null,
        baseBranch: binding.baseBranch ?? null,
        assistantEnabled: binding.assistantEnabled ?? null,
      });
    }
  }

  for (const route of audit.discord?.routes ?? []) {
    const laneId = route.lane ?? route.epicId ?? "general";
    addLane({
      projectId: route.projectId,
      laneId,
      label: laneId === "general" ? "General" : titleFromId(laneId),
      source: "route",
      channelId: route.channelId,
      threadId: null,
      epicId: route.epicId ?? null,
      baseBranch: route.baseBranch ?? null,
      assistantEnabled: route.assistantEnabled ?? null,
    });
  }

  for (const workstream of activeWorkstreams) {
    addLane({
      projectId: workstream.projectId,
      laneId: workstream.epicId ?? workstream.workstreamId,
      label: workstream.epicId ? titleFromId(workstream.epicId) : workstream.workstreamName,
      source: "workstream",
      channelId: null,
      threadId: null,
      epicId: workstream.epicId,
      baseBranch: null,
      assistantEnabled: null,
    });
  }

  for (const message of assistantMessages.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
    if (!message.project_id) {
      continue;
    }
    const laneId = message.lane_id ?? "general";
    addLane({
      projectId: message.project_id,
      laneId,
      label: laneId === "general" ? "General" : titleFromId(laneId),
      source: "thread",
      channelId: null,
      threadId: message.thread_id,
      epicId: null,
      baseBranch: null,
      assistantEnabled: null,
    });
  }

  return Array.from(lanesByProject.entries())
    .map(([projectId, laneMap]) => ({
      projectId,
      projectName: namesByProject.get(projectId) ?? titleFromId(projectId),
      lanes: Array.from(laneMap.values()).sort((a, b) => {
        if (a.laneId === "general") return -1;
        if (b.laneId === "general") return 1;
        return a.label.localeCompare(b.label);
      }),
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
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
  const assignments = buildAssignmentMap();
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
      const summary = toNoteSummary(note, source, assignments.get(assignmentKey("note", note.id)));
      recentNotes.push(summary);
      if (summary.context === "planning") {
        planningNotes.push(summary);
      }
      getBucket(summary.effectiveProjectId, note.project_name)?.notes.push(summary);
    }

    for (const task of assistantTasks.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      const source = resolveMessageSource(task.message_id);
      const mapped = toProjectTask(task, source, assignments.get(assignmentKey("task", task.id)));
      allTasks.push(mapped);
      getBucket(mapped.effectiveProjectId)?.tasks.push(mapped);
    }

    for (const event of assistantCalendarEvents.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      const source = resolveMessageSource(event.message_id);
      const mapped = toProjectCalendarEvent(event, source, assignments.get(assignmentKey("calendar", event.id)));
      allCalendarEvents.push(mapped);
      getBucket(mapped.effectiveProjectId)?.calendarEvents.push(mapped);
    }

    for (const message of assistantMessages.listRecent(RECENT_ASSISTANT_ROW_LIMIT)) {
      if (!isUnresolvedCapture(message)) {
        continue;
      }
      const source = sourceFromMessage(message);
      const mapped = toUnresolvedCapture(message, source, assignments.get(assignmentKey("capture", message.id)));
      getBucket(mapped.effectiveProjectId)?.unresolvedCaptures.push(mapped);
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
  const planBoard = buildPlanBoard(todayKey);
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
      projectId: event.effectiveProjectId,
      laneId: event.effectiveLaneId,
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
    planBoard,
  };
}

function taskToPlanItem(task: CommandCenterProjectTask): CommandCenterTodayPlanItem {
  return {
    id: task.id,
    title: task.title,
    details: task.details,
    source: "task",
    projectId: task.effectiveProjectId,
    laneId: task.effectiveLaneId,
    dueAt: task.dueAt,
    scheduledFor: task.scheduledFor,
    status: task.status,
    evidenceLinks: task.evidenceLinks,
  };
}

function buildPlanBoard(dateKey: string): CommandCenterPlanBoard {
  const sections: Record<CommandCenterPlanSection, CommandCenterPlanBoardItem[]> = {
    focus: [],
    next: [],
    later: [],
    waiting: [],
  };

  for (const row of dashboardPlanItems.listByDate(dateKey)) {
    const section = normalizePlanSection(row.section);
    if (!section || row.status === "archived" || row.status === "deleted") {
      continue;
    }
    if (row.item_type === "task") {
      const task = row.item_id ? assistantTasks.getById(row.item_id) : null;
      if (task && ["done", "archived"].includes(task.status)) {
        continue;
      }
    }
    sections[section].push(toPlanBoardItem(row, section));
  }

  for (const section of PLAN_SECTIONS) {
    sections[section].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  }

  return {
    date: dateKey,
    sections,
  };
}

function toPlanBoardItem(row: DashboardPlanItemRow, section: CommandCenterPlanSection): CommandCenterPlanBoardItem {
  return {
    id: row.id,
    date: row.date_key,
    section,
    title: row.title,
    details: row.details,
    itemType: normalizeDashboardItemType(row.item_type),
    itemId: row.item_id,
    projectId: row.project_id,
    laneId: row.lane_id,
    position: row.position,
    status: row.status,
    evidenceLinks: evidenceForDashboardItem(row.item_type, row.item_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  for (const note of bucket.notes) laneIds.add(note.effectiveLaneId ?? "general");
  for (const task of bucket.tasks) laneIds.add(task.effectiveLaneId ?? "general");
  for (const event of bucket.calendarEvents) laneIds.add(event.effectiveLaneId ?? "general");
  for (const workstream of bucket.workstreams) laneIds.add(workstream.epicId ?? workstream.workstreamId);
  for (const capture of bucket.unresolvedCaptures) laneIds.add(capture.effectiveLaneId ?? "general");

  return Array.from(laneIds).map((laneId) => {
    const notes = bucket.notes.filter((note) => (note.effectiveLaneId ?? "general") === laneId);
    const tasks = bucket.tasks.filter((task) => (task.effectiveLaneId ?? "general") === laneId);
    const calendar = bucket.calendarEvents.filter((event) => (event.effectiveLaneId ?? "general") === laneId);
    const streamRows = bucket.workstreams.filter((workstream) =>
      (workstream.epicId ?? workstream.workstreamId) === laneId
    );
    const captures = bucket.unresolvedCaptures.filter((capture) => (capture.effectiveLaneId ?? "general") === laneId);
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
      label: laneId === "general" ? "General" : titleFromId(laneId),
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

function toNoteSummary(
  note: AssistantNoteRow,
  source: SourceContext,
  assignment?: AssistantItemAssignmentRow,
): CommandCenterNoteSummary {
  return {
    id: note.id,
    title: note.title,
    excerpt: truncate(note.content, 220),
    context: normalizeAssistantContext(note.note_context),
    kind: note.note_kind,
    projectName: note.project_name,
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    sourceLaneId: source.laneId,
    effectiveProjectId: assignment?.project_id ?? source.sourceProjectId,
    effectiveLaneId: assignment?.lane_id ?? source.laneId,
    threadId: source.threadId,
    storagePath: note.storage_path,
    evidenceLinks: sourceEvidenceLinks(source, {
      noteStoragePath: note.storage_path,
      createdAt: note.created_at,
    }),
    createdAt: note.created_at,
  };
}

function toProjectTask(
  task: AssistantTaskRow,
  source: SourceContext,
  assignment?: AssistantItemAssignmentRow,
): CommandCenterProjectTask {
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
    sourceLaneId: source.laneId,
    effectiveProjectId: assignment?.project_id ?? source.sourceProjectId,
    effectiveLaneId: assignment?.lane_id ?? source.laneId,
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
  assignment?: AssistantItemAssignmentRow,
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
    sourceLaneId: source.laneId,
    effectiveProjectId: assignment?.project_id ?? source.sourceProjectId,
    effectiveLaneId: assignment?.lane_id ?? source.laneId,
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
  assignment?: AssistantItemAssignmentRow,
): CommandCenterUnresolvedCapture {
  return {
    id: message.id,
    body: message.body,
    excerpt: truncate(message.body, 220),
    sourceProjectId: source.sourceProjectId,
    laneId: source.laneId,
    sourceLaneId: source.laneId,
    effectiveProjectId: assignment?.project_id ?? source.sourceProjectId,
    effectiveLaneId: assignment?.lane_id ?? source.laneId,
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

function evidenceForDashboardItem(
  itemType: string | null,
  itemId: string | null,
): CommandCenterEvidenceLink[] {
  const normalized = normalizeDashboardItemType(itemType);
  if (!normalized || !itemId) {
    return [];
  }

  if (normalized === "task") {
    const task = assistantTasks.getById(itemId);
    return task ? sourceEvidenceLinks(resolveMessageSource(task.message_id), { createdAt: task.created_at }) : [];
  }
  if (normalized === "note") {
    const note = assistantNotes.getById(itemId);
    return note
      ? sourceEvidenceLinks(resolveMessageSource(note.message_id), {
          noteStoragePath: note.storage_path,
          createdAt: note.created_at,
        })
      : [];
  }
  if (normalized === "capture") {
    const message = assistantMessages.getById(itemId);
    return message ? sourceEvidenceLinks(sourceFromMessage(message), { createdAt: message.created_at }) : [];
  }
  if (normalized === "calendar") {
    const event = assistantCalendarEvents.getById(itemId);
    return event ? sourceEvidenceLinks(resolveMessageSource(event.message_id), { createdAt: event.created_at }) : [];
  }
  if (normalized === "workstream") {
    const row = workstreams.getById(itemId);
    return row
      ? [
          {
            kind: "workstream",
            label: row.name,
            target: `/api/workstreams/${row.id}/status`,
            sourceProjectId: row.project_id,
            laneId: row.epic_id,
            createdAt: row.created_at,
          },
        ]
      : [];
  }

  return [];
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

function buildAssignmentMap(): AssignmentMap {
  return new Map(assistantItemAssignments.list().map((assignment) => [
    assignmentKey(assignment.item_type, assignment.item_id),
    assignment,
  ]));
}

function assignmentKey(itemType: string, itemId: string): string {
  return `${itemType}:${itemId}`;
}

function normalizeDashboardItemType(value: string | null | undefined): CommandCenterDashboardItemType | null {
  return DASHBOARD_ITEM_TYPES.includes(value as CommandCenterDashboardItemType)
    ? value as CommandCenterDashboardItemType
    : null;
}

function normalizePlanSection(value: string | null | undefined): CommandCenterPlanSection | null {
  return PLAN_SECTIONS.includes(value as CommandCenterPlanSection)
    ? value as CommandCenterPlanSection
    : null;
}

function requirePlanSection(value: string | null | undefined): CommandCenterPlanSection {
  const section = normalizePlanSection(value);
  if (!section) {
    throw new Error(`Invalid plan section: ${value ?? ""}`);
  }
  return section;
}

function normalizeLaneId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "general" ? trimmed : null;
}

function assertDashboardItemExists(itemType: CommandCenterDashboardItemType, itemId: string): void {
  const found =
    itemType === "task" ? assistantTasks.getById(itemId) :
    itemType === "note" ? assistantNotes.getById(itemId) :
    itemType === "capture" ? assistantMessages.getById(itemId) :
    itemType === "calendar" ? assistantCalendarEvents.getById(itemId) :
    itemType === "workstream" ? workstreams.getById(itemId) :
    null;
  if (!found) {
    throw new Error(`${titleFromId(itemType)} not found: ${itemId}`);
  }
}

function assertValidAssignment(orchestrator: Orchestrator, projectId: string, laneId: string | null): void {
  const activeWorkstreams = orchestrator
    .listActiveWorkstreams()
    .map((workstream) => orchestrator.getWorkstreamStatusSnapshot(workstream.id))
    .filter((snapshot): snapshot is WorkstreamStatusSnapshot => snapshot !== null);
  const options = buildOrganizationOptions(orchestrator, activeWorkstreams);
  const project = options.find((option) => option.projectId === projectId);
  if (!project) {
    throw new Error(`Unknown dashboard project: ${projectId}`);
  }
  if (!laneId) {
    return;
  }
  if (!project.lanes.some((lane) => lane.laneId === laneId)) {
    throw new Error(`Project "${projectId}" does not define lane "${laneId}".`);
  }
}

function resolvePlanItemDefaults(
  rawItemType: string | null,
  itemId: string | null,
): {
  itemType: CommandCenterDashboardItemType | null;
  itemId: string | null;
  title: string;
  details: string | null;
  projectId: string | null;
  laneId: string | null;
} {
  const itemType = normalizeDashboardItemType(rawItemType);
  if (!itemType || !itemId) {
    return {
      itemType: itemType ?? null,
      itemId: itemId ?? null,
      title: "",
      details: null,
      projectId: null,
      laneId: null,
    };
  }
  assertDashboardItemExists(itemType, itemId);
  const assignment = assistantItemAssignments.get(itemType, itemId);
  if (itemType === "task") {
    const task = assistantTasks.getById(itemId)!;
    const source = resolveMessageSource(task.message_id);
    return {
      itemType,
      itemId,
      title: task.title,
      details: task.details,
      projectId: assignment?.project_id ?? source.sourceProjectId,
      laneId: assignment?.lane_id ?? source.laneId,
    };
  }
  if (itemType === "note") {
    const note = assistantNotes.getById(itemId)!;
    const source = resolveMessageSource(note.message_id);
    return {
      itemType,
      itemId,
      title: note.title,
      details: truncate(note.content, 260),
      projectId: assignment?.project_id ?? source.sourceProjectId,
      laneId: assignment?.lane_id ?? source.laneId,
    };
  }
  if (itemType === "capture") {
    const message = assistantMessages.getById(itemId)!;
    return {
      itemType,
      itemId,
      title: summarizeDashboardTaskTitle(message.body),
      details: message.body,
      projectId: assignment?.project_id ?? message.project_id,
      laneId: assignment?.lane_id ?? message.lane_id,
    };
  }
  if (itemType === "calendar") {
    const event = assistantCalendarEvents.getById(itemId)!;
    const source = resolveMessageSource(event.message_id);
    return {
      itemType,
      itemId,
      title: event.title,
      details: event.details,
      projectId: assignment?.project_id ?? source.sourceProjectId,
      laneId: assignment?.lane_id ?? source.laneId,
    };
  }
  if (itemType === "workstream") {
    const row = workstreams.getById(itemId)!;
    return {
      itemType,
      itemId,
      title: row.name,
      details: row.current_goal ?? row.description,
      projectId: assignment?.project_id ?? row.project_id,
      laneId: assignment?.lane_id ?? row.epic_id,
    };
  }
  return {
    itemType,
    itemId,
    title: "",
    details: null,
    projectId: null,
    laneId: null,
  };
}

function nextPlanPosition(dateKey: string, section: CommandCenterPlanSection): number {
  const positions = dashboardPlanItems
    .listByDate(dateKey)
    .filter((item) => item.section === section)
    .map((item) => item.position);
  return positions.length > 0 ? Math.max(...positions) + 1 : 0;
}

function requireNonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function summarizeDashboardTaskTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return truncate(normalized || "Dashboard task", 72);
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
