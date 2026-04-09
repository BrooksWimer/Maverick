export type ClaudePermissionMode = "plan" | "auto" | "default";
export type BriefTrigger = "manual" | "schedule";

export interface GitStatusSnapshot {
  branch: string | null;
  trackingBranch: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  statusLines: string[];
  recentCommits: string[];
  error?: string;
}

export interface BriefTurnSnapshot {
  status: string;
  instruction: string;
  summary: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface WorkstreamBriefSummary {
  id: string;
  name: string;
  state: string;
  summary: string | null;
  currentGoal: string | null;
  pendingDecision: string | null;
  waitingOnApproval: boolean;
  lastActivityAt: string;
  latestTurn: BriefTurnSnapshot | null;
}

export interface ProjectApprovalSummary {
  id: string;
  workstreamId: string;
  workstreamName: string;
  type: string;
  tier: string;
  description: string;
  createdAt: string;
}

export interface AssistantNoteSummary {
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export interface ReminderSummary {
  body: string;
  remindAt: string;
  channel: string;
  destination: string | null;
  status: string;
}

export interface CalendarEventSummary {
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  provider: string;
  syncStatus: string;
}

export interface ProjectBriefContext {
  id: string;
  name: string;
  repoPath: string;
  git: GitStatusSnapshot;
  workstreams: WorkstreamBriefSummary[];
  pendingApprovals: ProjectApprovalSummary[];
  taggedNotes: AssistantNoteSummary[];
}

export interface AssistantBriefContext {
  generalNotes: AssistantNoteSummary[];
  upcomingReminders: ReminderSummary[];
  upcomingCalendarEvents: CalendarEventSummary[];
}

export interface BriefContext {
  generatedAt: string;
  since: string;
  projects: ProjectBriefContext[];
  assistant: AssistantBriefContext;
}

export interface GeneratedBrief {
  generatedAt: string;
  trigger: BriefTrigger;
  content: string;
  markdown: string;
  storagePath: string | null;
  channelId: string | null;
  summary: string;
}

export interface ReviewContextPayload {
  projectId: string;
  workstreamName: string;
  instruction: string;
  turnSummary: string | null;
  turnOutput: string;
  gitDiff: string;
  gitStatus: string;
  epicCharter: string | null;
  testResults: string | null;
}

export interface PlanningContextPayload {
  projectId: string;
  workstreamName: string;
  instruction: string;
  agentsMd: string;
  directoryTree: string;
  recentTurnHistory: Array<{
    instruction: string;
    status: string;
    summary: string | null;
  }>;
  epicCharter: string | null;
}
