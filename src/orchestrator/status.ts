export type WorkstreamHealth =
  | "done"
  | "blocked"
  | "waiting-on-approval"
  | "awaiting-input"
  | "running"
  | "quiet"
  | "failed"
  | "ready-for-review"
  | "idle";

export type OperatorReportKind = "plan" | "dispatch" | "verification" | "review";

export type OperatorValidationStatus = "pass" | "fail" | "warning" | "info" | "skipped";

export interface OperatorValidationEvidence {
  label: string;
  status: OperatorValidationStatus;
  detail: string;
  command?: string;
}

export interface OperatorReportArtifactMetadata {
  schemaVersion: number;
  kind: OperatorReportKind;
  headline: string;
  summary: string;
  filesChanged: string[];
  validation: OperatorValidationEvidence[];
  remainingRisks: string[];
  nextAction: string;
  sourceEvent: string;
  generatedAt: string;
  turnId: string | null;
}

export interface StatusLatestTurn {
  id: string;
  status: string;
  instruction: string;
  resultSummary: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  completedAt: string | null;
}

export interface StatusPlanningSummary {
  status: "none" | "needs-answers" | "needs-final-prompt" | "ready";
  pendingQuestionCount: number;
  finalPromptReady: boolean;
}

export interface StatusVerificationSummary {
  status: "none" | "pass" | "fail";
  recommendation: "ready-for-review" | "needs-fixes" | null;
  introducedFailureCount: number;
}

export interface ActiveOperationSnapshot {
  kind: "implementation" | "planning" | "review" | "verification";
  startedAt: string;
  lastProgressAt: string;
  quiet: boolean;
}

export interface WorkstreamStatusSnapshot {
  workstreamId: string;
  workstreamName: string;
  projectId: string;
  epicId: string | null;
  state: string;
  branch: string | null;
  workspace: string | null;
  codexThreadId: string | null;
  currentGoal: string | null;
  waitingOnApproval: boolean;
  pendingApprovalCount: number;
  health: WorkstreamHealth;
  healthReason: string | null;
  planning: StatusPlanningSummary;
  verification: StatusVerificationSummary;
  latestTurn: StatusLatestTurn | null;
  latestReport: OperatorReportArtifactMetadata | null;
  activeOperation: ActiveOperationSnapshot | null;
  nextAction: string;
  generatedAt: string;
}

function renderValidationLine(evidence: OperatorValidationEvidence): string {
  const commandSuffix = evidence.command ? ` via \`${evidence.command}\`` : "";
  return `- [${evidence.status}] ${evidence.label}: ${evidence.detail}${commandSuffix}`;
}

function renderList(title: string, values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  return [title, ...values.map((value) => `- ${value}`)].join("\n");
}

export function renderWorkstreamStatusSnapshot(snapshot: WorkstreamStatusSnapshot): string {
  const report = snapshot.latestReport;

  return [
    `Workstream: \`${snapshot.workstreamName}\``,
    `ID: \`${snapshot.workstreamId}\``,
    `Project: \`${snapshot.projectId}\``,
    snapshot.epicId ? `Epic: \`${snapshot.epicId}\`` : null,
    `State: \`${snapshot.state}\``,
    `Health: \`${snapshot.health}\`${snapshot.healthReason ? ` - ${snapshot.healthReason}` : ""}`,
    snapshot.branch ? `Branch: \`${snapshot.branch}\`` : "Branch: shared repository root",
    snapshot.workspace ? `Workspace: \`${snapshot.workspace}\`` : null,
    snapshot.activeOperation
      ? `Active operation: \`${snapshot.activeOperation.kind}\` (last progress ${snapshot.activeOperation.lastProgressAt})`
      : null,
    snapshot.currentGoal ? `Current goal: ${snapshot.currentGoal}` : null,
    snapshot.latestTurn ? `Latest turn: \`${snapshot.latestTurn.status}\`` : null,
    snapshot.latestTurn?.resultSummary ? `Latest turn summary: ${snapshot.latestTurn.resultSummary}` : null,
    snapshot.planning.status !== "none"
      ? snapshot.planning.status === "needs-answers"
        ? `Planning: awaiting ${snapshot.planning.pendingQuestionCount} answer(s)`
        : snapshot.planning.status === "ready"
          ? "Planning: final execution prompt ready"
          : "Planning: structured context stored, final prompt not ready"
      : null,
    snapshot.verification.status !== "none"
      ? snapshot.verification.status === "pass"
        ? "Verification: passed"
        : `Verification: failed with ${snapshot.verification.introducedFailureCount} introduced issue${snapshot.verification.introducedFailureCount === 1 ? "" : "s"}`
      : null,
    report ? "" : null,
    report ? `Latest report: ${report.headline}` : null,
    report ? `Report summary: ${report.summary}` : null,
    report && report.filesChanged.length > 0
      ? `Files changed: ${report.filesChanged.join(", ")}`
      : null,
    report && report.validation.length > 0
      ? ["Validation evidence:", ...report.validation.map((entry) => renderValidationLine(entry))].join("\n")
      : null,
    report ? renderList("Remaining risks:", report.remainingRisks) : null,
    `Next action: ${snapshot.nextAction}`,
    snapshot.codexThreadId ? `Codex thread: \`${snapshot.codexThreadId}\`` : null,
    `Waiting on approval: ${snapshot.waitingOnApproval ? "yes" : "no"}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
