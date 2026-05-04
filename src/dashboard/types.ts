import type {
  AssistantAgendaSnapshot,
  AssistantPrimaryContext,
} from "../assistant/types.js";
import type {
  OperatorReportArtifactMetadata,
  WorkstreamHealth,
  WorkstreamStatusSnapshot,
} from "../orchestrator/status.js";

export type CommandCenterHealthStatus = "ok" | "active" | "attention" | "unavailable";
export type CommandCenterEvidenceLinkKind =
  | "discord-thread"
  | "assistant-message"
  | "note-file"
  | "workstream"
  | "repo-path"
  | "artifact";
export type CommandCenterProjectIntelligenceStatus = "idle" | "active" | "attention";

export interface CommandCenterEvidenceLink {
  kind: CommandCenterEvidenceLinkKind;
  label: string;
  target: string;
  sourceProjectId: string | null;
  laneId: string | null;
  createdAt: string | null;
}

export interface CommandCenterTaskSummary {
  overdue: number;
  dueToday: number;
  open: number;
  scheduled: number;
  inbox: number;
  totalActionable: number;
  byContext: Record<AssistantPrimaryContext, number>;
}

export interface CommandCenterProjectSummary {
  id: string;
  name: string;
  workspaceKind: string;
  repoPath: string;
  activeWorkstreamCount: number;
  pendingApprovalCount: number;
  states: Record<string, number>;
  health: WorkstreamHealth | "ok" | "attention";
  healthReason: string | null;
  latestActivityAt: string | null;
}

export interface CommandCenterReportSummary {
  artifactId: string;
  workstreamId: string;
  workstreamName: string;
  projectId: string;
  kind: OperatorReportArtifactMetadata["kind"];
  headline: string;
  summary: string;
  filesChanged: string[];
  validation: OperatorReportArtifactMetadata["validation"];
  remainingRisks: string[];
  nextAction: string;
  generatedAt: string;
  createdAt: string;
}

export interface CommandCenterApprovalSummary {
  id: string;
  workstreamId: string;
  workstreamName: string | null;
  projectId: string | null;
  type: string;
  tier: string;
  description: string;
  createdAt: string;
}

export interface CommandCenterEventSummary {
  id: number;
  projectId: string | null;
  workstreamId: string | null;
  eventType: string;
  source: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface CommandCenterNoteSummary {
  id: string;
  title: string;
  excerpt: string;
  context: AssistantPrimaryContext;
  kind: string | null;
  projectName: string | null;
  sourceProjectId: string | null;
  laneId: string | null;
  threadId: string | null;
  storagePath: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
  createdAt: string;
}

export interface CommandCenterHealthSummary {
  status: CommandCenterHealthStatus;
  reason: string;
  assistantAvailable: boolean;
  failedWorkstreamCount: number;
  blockedWorkstreamCount: number;
  waitingOnApprovalCount: number;
  staleWorkstreamCount: number;
}

export interface CommandCenterTodayPlanItem {
  id: string;
  title: string;
  details: string;
  source: "task" | "note" | "calendar" | "workstream";
  projectId: string | null;
  laneId: string | null;
  dueAt: string | null;
  scheduledFor: string | null;
  status: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
}

export interface CommandCenterTodayCalendarEvent {
  id: string;
  title: string;
  details: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  location: string | null;
  syncStatus: string;
  projectId: string | null;
  laneId: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
}

export interface CommandCenterTodayPlan {
  date: string;
  timeZone: string;
  headline: string;
  focus: CommandCenterTodayPlanItem[];
  tasks: CommandCenterTodayPlanItem[];
  personal: CommandCenterTodayPlanItem[];
  calendarEvents: CommandCenterTodayCalendarEvent[];
  planningNotes: CommandCenterNoteSummary[];
}

export interface CommandCenterProjectTask {
  id: string;
  title: string;
  details: string;
  primaryContext: AssistantPrimaryContext;
  status: string;
  dueAt: string | null;
  scheduledFor: string | null;
  sourceProjectId: string | null;
  laneId: string | null;
  threadId: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
  createdAt: string;
  updatedAt: string;
}

export interface CommandCenterProjectCalendarEvent {
  id: string;
  title: string;
  details: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  location: string | null;
  syncStatus: string;
  sourceProjectId: string | null;
  laneId: string | null;
  threadId: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
  createdAt: string;
}

export interface CommandCenterUnresolvedCapture {
  id: string;
  body: string;
  excerpt: string;
  sourceProjectId: string | null;
  laneId: string | null;
  threadId: string | null;
  status: string;
  intent: string | null;
  evidenceLinks: CommandCenterEvidenceLink[];
  createdAt: string;
}

export interface CommandCenterProjectLaneSummary {
  laneId: string;
  headline: string;
  keyUpdates: string[];
  actionItems: string[];
  latestActivityAt: string | null;
  noteCount: number;
  taskCount: number;
  calendarEventCount: number;
  workstreamCount: number;
  unresolvedCaptureCount: number;
  evidenceLinks: CommandCenterEvidenceLink[];
}

export interface CommandCenterProjectIntelligenceSummary {
  projectId: string;
  projectName: string;
  generatedAt: string;
  status: CommandCenterProjectIntelligenceStatus;
  headline: string;
  keyUpdates: string[];
  actionItems: string[];
  latestNoteAt: string | null;
  activeWorkstreamCount: number;
  laneCount: number;
  unresolvedCaptureCount: number;
  evidenceLinks: CommandCenterEvidenceLink[];
}

export interface CommandCenterProjectIntelligenceDetail extends CommandCenterProjectIntelligenceSummary {
  lanes: CommandCenterProjectLaneSummary[];
  notes: CommandCenterNoteSummary[];
  tasks: CommandCenterProjectTask[];
  calendarEvents: CommandCenterProjectCalendarEvent[];
  workstreams: WorkstreamStatusSnapshot[];
  unresolvedCaptures: CommandCenterUnresolvedCapture[];
}

export interface CommandCenterSnapshot {
  generatedAt: string;
  assistantAgenda: AssistantAgendaSnapshot | null;
  taskSummary: CommandCenterTaskSummary;
  todayPlan: CommandCenterTodayPlan;
  projectSummaries: CommandCenterProjectSummary[];
  projectIntelligenceSummaries: CommandCenterProjectIntelligenceSummary[];
  activeWorkstreams: WorkstreamStatusSnapshot[];
  latestReports: CommandCenterReportSummary[];
  pendingApprovals: CommandCenterApprovalSummary[];
  recentEvents: CommandCenterEventSummary[];
  recentNotes: CommandCenterNoteSummary[];
  health: CommandCenterHealthSummary;
  nextAction: string;
}
