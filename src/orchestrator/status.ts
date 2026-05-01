import { renderMarkdownDocument, renderBulletSection } from "../markdown/presentation.js";

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
  budget: {
    limitUsd: number;
    spentUsd: number;
    remainingUsd: number;
  };
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

export function renderWorkstreamStatusSnapshot(snapshot: WorkstreamStatusSnapshot): string {
  const report = snapshot.latestReport;

  return renderMarkdownDocument({
    title: `Workstream Status - ${snapshot.workstreamName}`,
    summary: [
      `State: \`${snapshot.state}\``,
      `Health: \`${snapshot.health}\`${snapshot.healthReason ? ` - ${snapshot.healthReason}` : ""}`,
      snapshot.currentGoal ? `Goal: ${snapshot.currentGoal}` : "",
    ].filter(Boolean),
    facts: [
      { label: "Workstream ID", value: `\`${snapshot.workstreamId}\`` },
      { label: "Project", value: `\`${snapshot.projectId}\`` },
      { label: "Epic", value: snapshot.epicId ? `\`${snapshot.epicId}\`` : null },
      { label: "Branch", value: snapshot.branch ? `\`${snapshot.branch}\`` : "shared repository root" },
      { label: "Workspace", value: snapshot.workspace ? `\`${snapshot.workspace}\`` : null },
      { label: "Codex thread", value: snapshot.codexThreadId ? `\`${snapshot.codexThreadId}\`` : null },
      { label: "Waiting on approval", value: snapshot.waitingOnApproval ? "yes" : "no" },
      {
        label: "Budget",
        value: `$${snapshot.budget.spentUsd.toFixed(2)} / $${snapshot.budget.limitUsd.toFixed(2)} used`,
      },
      {
        label: "Active operation",
        value: snapshot.activeOperation
          ? `\`${snapshot.activeOperation.kind}\` (last progress ${snapshot.activeOperation.lastProgressAt})`
          : null,
      },
      { label: "Latest turn", value: snapshot.latestTurn ? `\`${snapshot.latestTurn.status}\`` : null },
    ],
    callouts: [
      {
        label: "Next Action",
        body: snapshot.nextAction,
        tone: snapshot.health === "failed" || snapshot.health === "blocked" ? "warning" : "info",
      },
      report
        ? {
            label: "Latest Report",
            body: `${report.headline}${report.summary ? `\n\n${report.summary}` : ""}`,
            tone: "info" as const,
          }
        : null,
    ].filter(Boolean) as Array<{ label: string; body: string; tone?: "info" | "warning" }>,
    sections: [
      renderBulletSection("Planning", [
        snapshot.planning.status === "none"
          ? "No structured planning state recorded."
          : snapshot.planning.status === "needs-answers"
            ? `Awaiting ${snapshot.planning.pendingQuestionCount} answer(s).`
            : snapshot.planning.status === "ready"
              ? "Final execution prompt ready."
              : "Structured context stored, but final prompt is not ready.",
      ]),
      renderBulletSection("Verification", [
        snapshot.verification.status === "none"
          ? "No verification recorded."
          : snapshot.verification.status === "pass"
            ? "Verification passed."
            : `Verification failed with ${snapshot.verification.introducedFailureCount} introduced issue${snapshot.verification.introducedFailureCount === 1 ? "" : "s"}.`,
      ]),
      renderBulletSection("Latest Turn", snapshot.latestTurn?.resultSummary ? [snapshot.latestTurn.resultSummary] : []),
      renderBulletSection("Files Changed", report?.filesChanged ?? []),
      {
        title: "Evidence",
        lines: report?.validation.map((entry) => renderValidationLine(entry)) ?? [],
      },
      renderBulletSection("Open Items", report?.remainingRisks ?? []),
    ],
  });
}
