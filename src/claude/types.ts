export type ClaudePermissionMode = "plan" | "auto" | "default";

export interface ProjectBriefContext {
  id: string;
  name: string;
  repoPath: string;
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
