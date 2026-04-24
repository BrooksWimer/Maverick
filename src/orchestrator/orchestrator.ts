/**
 * Orchestrator core: the central coordinator.
 *
 * Maps user intents (from Discord, HTTP, or CLI) to workstream actions,
 * manages the execution backend, persists state, and emits events.
 *
 * Design principle: the orchestrator is interface-agnostic. It doesn't know
 * about Discord or HTTP — it only knows about workstreams, turns, and events.
 * The Discord and HTTP modules are event consumers that subscribe to the event bus.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  BriefCollector,
  briefFilename,
  cronMatchesDate,
  renderBriefMarkdown,
  scheduledMinuteKey,
  summarizeBrief,
  type BriefTrigger,
  type GeneratedBrief,
} from "../claude/index.js";
import { runAgent } from "../agents/agent-runner.js";
import { coerceBriefAgentResult, renderBriefContent } from "../agents/brief-support.js";
import { renderEpicContextAnalysis } from "../agents/epic-context-support.js";
import {
  parseGoalFrameResult,
  parseIntakeResult,
  renderGoalFrameMarkdown,
  renderIntakeMarkdown,
} from "../agents/goal-framing-support.js";
import {
  buildIncidentContinuationInstruction,
  coerceIncidentTriageResult,
} from "../agents/incident-triage-support.js";
import { parseModelingResult, renderModelingMarkdown } from "../agents/modeling-support.js";
import { coerceOperatorFeedbackResult, renderOperatorFeedbackMarkdown } from "../agents/operator-feedback-support.js";
import {
  buildPlanningContextRecord,
  mergePlanningAnswers,
  parsePlanningContextRecord,
  parsePlanningResult,
  renderPlanningSummary,
  serializePlanningAnswers,
} from "../agents/planning-support.js";
import { coerceExplanationResult } from "../agents/response-formatting-support.js";
import { coerceReviewAgentResult } from "../agents/review-support.js";
import { parseTestDesignResult, renderTestDesignMarkdown } from "../agents/test-design-support.js";
import {
  buildVerificationContextRecord,
  coerceVerificationResult,
  parseVerificationContextRecord,
  renderVerificationSummary,
} from "../agents/verification-support.js";
import { createLogger } from "../logger.js";
import { eventBus } from "./event-bus.js";
import type {
  ActiveOperationSnapshot,
  OperatorReportArtifactMetadata,
  OperatorValidationEvidence,
  StatusLatestTurn,
  WorkstreamHealth,
  WorkstreamStatusSnapshot,
} from "./status.js";
import { WorkstreamStateMachine } from "./state-machine.js";
import { artifacts, projects, workstreams, turns, approvals, events as eventLog } from "../state/index.js";
import type { ArtifactRow, TurnRow, WorkstreamRow } from "../state/index.js";
import { createAdapter, type ExecutionBackendAdapter } from "../codex/index.js";
import type { ApprovalRequest, ExecutionThread, ReviewResult } from "../codex/types.js";
import type { EscalationTier, OrchestratorConfig, ProjectConfig, RemoteHostConfig } from "../config/schema.js";
import { ensureProjectBootstrap, ensureWorktreeBootstrap, type BootstrapStatus } from "../projects/bootstrap.js";
import { buildEpicCharterContext, requireEpicById, workstreamLaneForEpic } from "../projects/epics.js";
import { provisionWorktree } from "../git/worktree.js";
import type {
  ExplanationResult,
  GoalFrameResult,
  IntakeResult,
  ModelingResult,
  OperatorFeedbackResult,
  PlanningAnswer,
  PlanningContextRecord,
  TestDesignResult,
  VerificationContextRecord,
} from "../agents/types.js";

const log = createLogger("orchestrator");

type PlanningRunTrigger = "manual" | "auto" | "resume";

type GeneratedPlanResult = {
  renderedPlan: string;
  planningContext: PlanningContextRecord;
  finalExecutionPrompt: string | null;
  needsAnswers: boolean;
};

type GeneratePlanOptions = {
  resumeExisting?: boolean;
};

type VerificationRunTrigger = "manual" | "auto";

const SAFE_COMMAND_PATTERNS = [
  /\bgo\s+test\b/i,
  /\bgo\s+build\b/i,
  /\bgo\s+fmt\b/i,
  /\bgofmt\b/i,
  /\bnpm\s+test\b/i,
  /\bnpm\s+run\s+(test|build|lint|typecheck|check)\b/i,
  /\bpnpm\s+(test|lint|build)\b/i,
  /\bpnpm\s+run\s+(test|build|lint|typecheck|check)\b/i,
  /\byarn\s+(test|lint|build)\b/i,
  /\byarn\s+run\s+(test|build|lint|typecheck|check)\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bvitest\b/i,
  /\bpytest\b/i,
  /\bpython(?:3)?\s+-m\s+pytest\b/i,
  /\bcargo\s+(test|build|check|fmt)\b/i,
  /\bgit\s+(status|diff|show|log|branch|checkout|switch)\b/i,
  /\brg\b/i,
  /\bgrep\b/i,
  /\bselect-string\b/i,
  /\bget-childitem\b/i,
];

const APPROVAL_GATED_PATTERNS = [
  /\bnpm\s+(install|i)\b/i,
  /\bpnpm\s+(install|add)\b/i,
  /\byarn\s+(install|add)\b/i,
  /\bpip(?:3)?\s+install\b/i,
  /\bpython(?:3)?\s+-m\s+pip\s+install\b/i,
  /\bgo\s+get\b/i,
  /\bcargo\s+add\b/i,
  /\bwinget\s+install\b/i,
  /\bchoco\s+install\b/i,
];

const HUMAN_DECISION_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bremove-item\b.*\b-recurse\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bdrop\s+table\b/i,
  /\bformat\b/i,
];

const PROTECTED_CONFIG_PATH_PATTERNS = [
  /(^|[\\/])\.github[\\/]/i,
  /(^|[\\/])deploy[\\/]/i,
  /(^|[\\/])docker-compose(\.[^.]+)?\.ya?ml$/i,
  /(^|[\\/])dockerfile$/i,
  /(^|[\\/])package(-lock)?\.json$/i,
  /(^|[\\/])pnpm-lock\.ya?ml$/i,
  /(^|[\\/])yarn\.lock$/i,
  /(^|[\\/])tsconfig(\.[^.]+)?\.json$/i,
  /(^|[\\/])\.eslintrc(\.[^.]+)?$/i,
  /(^|[\\/])eslint\.config\.[^.]+$/i,
  /(^|[\\/])\.prettierrc(\.[^.]+)?$/i,
  /(^|[\\/])prettier\.config\.[^.]+$/i,
];

const QUIET_HEALTH_THRESHOLD_MS = 20 * 60 * 1000;

const SAFE_REMOTE_INSPECTION_PATTERNS = [
  /\bgit\s+(?:-c\s+\S+\s+)?(?:-C\s+\S+\s+)?(status|diff|show|log)\b/i,
  /\bjournalctl\b/i,
  /\bsystemctl\s+status\b/i,
  /\bbluetoothctl\s+(show|devices|paired-devices|info)\b/i,
  /\b(ls|pwd|cat|tail|head|wc|stat|uname|df|du|free)\b/i,
  /\b(rg|grep|find)\b/i,
];

const UNSAFE_REMOTE_COMMAND_PATTERNS = [
  /\bsudo\b/i,
  /\bsystemctl\s+(start|stop|restart|reload|enable|disable|daemon-reload)\b/i,
  /\bapt(?:-get)?\b/i,
  /\bpip(?:3)?\s+install\b/i,
  /\bpython(?:3)?\s+-m\s+pip\s+install\b/i,
  /\bnpm\s+(install|i)\b/i,
  /\bpnpm\s+(install|add)\b/i,
  /\byarn\s+(install|add)\b/i,
  /\bgo\s+get\b/i,
  /\bcargo\s+add\b/i,
  /\bscp\b/i,
  /\brsync\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\brm\b/i,
  /\bsed\s+-i\b/i,
  /\btee\b/i,
  /\bgit\s+(add|commit|push|pull|checkout|switch|reset|clean|apply|merge|rebase|cherry-pick)\b/i,
];

function isPathWithinRoot(candidatePath: string, allowedRoot: string): boolean {
  const normalizedRoot = resolve(allowedRoot);
  const normalizedCandidate = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(allowedRoot, candidatePath);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":"));
}

function commandTextFromRequest(request: ApprovalRequest): string {
  const rawCommand = request.context.command;
  if (typeof rawCommand === "string" && rawCommand.length > 0) {
    return rawCommand;
  }

  const commandActions = request.context.commandActions;
  const commandActionText = collectContextStrings(commandActions).join("\n");
  return commandActionText;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function collectContextStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectContextStrings(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectContextStrings(entry));
  }

  return [];
}

type ActiveOperationKind = ActiveOperationSnapshot["kind"];

type ActiveOperationState = {
  kind: ActiveOperationKind;
  startedAt: string;
  lastProgressAt: string;
};

export class Orchestrator {
  private config: OrchestratorConfig;
  private adapters: Map<string, ExecutionBackendAdapter> = new Map();
  private stateMachines: Map<string, WorkstreamStateMachine> = new Map();
  private activeTurnByWorkstream = new Map<string, string>();
  private activeOperationByWorkstream = new Map<string, ActiveOperationState>();
  private projectBootstrap = new Map<string, BootstrapStatus>();
  private utilityClaudeAdapter: ExecutionBackendAdapter | null = null;
  private briefTimer: NodeJS.Timeout | null = null;
  private lastBriefScheduleKey: string | null = null;
  private briefInFlight: Promise<GeneratedBrief> | null = null;
  private initialized = false;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    if (this.initialized) return;

    log.info("Initializing orchestrator");

    this.syncConfiguredProjects();

    // Create execution adapters per project (or use default)
    for (const project of this.config.projects) {
      const bootstrapStatus = ensureProjectBootstrap(project);
      this.projectBootstrap.set(project.id, bootstrapStatus);
      log.info(
        {
          projectId: project.id,
          createdBootstrapFiles: bootstrapStatus.createdFiles.length,
        },
        "Project bootstrap ensured"
      );

      const backendConfig = project.executionBackend ?? this.config.defaults.executionBackend;
      const adapter = createAdapter(backendConfig);
      await adapter.initialize();

      // Wire adapter events to event bus
      adapter.onOutput((threadId, content, isPartial) => {
        const ws = this.findWorkstreamByThread(threadId);
        if (ws) {
          this.touchProgress("implementation", ws.id);
          eventBus.emit("turn.output", {
            workstreamId: ws.id,
            turnId: this.activeTurnByWorkstream.get(ws.id) ?? "",
            content,
            isPartial,
          });
        }
      });

      adapter.onApprovalRequest((threadId, request) => {
        const ws = this.findWorkstreamByThread(threadId);
        if (ws) {
          this.handleApprovalRequest(ws.id, request);
        }
      });

      this.adapters.set(project.id, adapter);

      // Create state machine for project
      const workflow = project.workflow ?? this.config.defaults.workflow;
      this.stateMachines.set(project.id, new WorkstreamStateMachine(workflow));

      log.info({ projectId: project.id, backend: backendConfig.type }, "Project adapter ready");
    }

    // Recover active workstreams from database
    await this.recoverActiveWorkstreams();

    this.initialized = true;
    this.startBriefScheduler();
    log.info({ projects: this.config.projects.length }, "Orchestrator initialized");
  }

  async shutdown(): Promise<void> {
    log.info("Shutting down orchestrator");
    if (this.briefTimer) {
      clearInterval(this.briefTimer);
      this.briefTimer = null;
    }
    for (const [id, adapter] of this.adapters) {
      log.info({ projectId: id }, "Shutting down adapter");
      await adapter.shutdown();
    }
    if (this.utilityClaudeAdapter) {
      await this.utilityClaudeAdapter.shutdown();
      this.utilityClaudeAdapter = null;
    }
    this.initialized = false;
  }

  // --- Workstream operations ---

  async createWorkstream(params: {
    projectId: string;
    name: string;
    description?: string;
    discordChannelId?: string;
    baseBranch?: string;
    lane?: string;
    epicId?: string;
  }) {
    const project = this.getProject(params.projectId);
    const adapter = this.getAdapter(params.projectId);
    const sm = this.getStateMachine(params.projectId);
    let resolvedBaseBranch = params.baseBranch;
    let resolvedLane = params.lane;

    if (params.epicId) {
      const epic = requireEpicById(project, params.epicId);
      const epicLane = workstreamLaneForEpic(epic);
      if (params.baseBranch && params.baseBranch !== epic.branch) {
        throw new Error(
          `Workstream requested epic "${params.epicId}" but base branch "${params.baseBranch}" does not match "${epic.branch}".`
        );
      }
      if (params.lane && params.lane !== epicLane) {
        throw new Error(
          `Workstream requested epic "${params.epicId}" but lane "${params.lane}" does not match "${epicLane}".`
        );
      }

      resolvedBaseBranch ??= epic.branch;
      resolvedLane ??= epicLane;
    }

    if (project.requireEpicForWorktree && !resolvedBaseBranch) {
      throw new Error(
        `Project "${project.id}" requires an epic/base branch selection before Maverick can create a worktree.`
      );
    }

    const workstreamId = randomUUID();
    const workspace = await provisionWorktree({
      repoPath: project.repoPath,
      projectId: params.projectId,
      workstreamId,
      name: params.name,
      lane: resolvedLane,
      baseRef: resolvedBaseBranch,
    });

    if (workspace.mode === "worktree") {
      ensureWorktreeBootstrap(project, workspace.cwd);
    }

    // Create execution thread
    const thread = await adapter.createThread(workspace.cwd);

    // Persist workstream
    const ws = workstreams.create({
      id: workstreamId,
      project_id: params.projectId,
      epic_id: params.epicId,
      name: params.name,
      description: params.description,
      cwd: workspace.cwd,
      branch: workspace.branch ?? undefined,
      execution_backend: adapter.name,
      discord_channel_id: params.discordChannelId,
    });

    // Bind thread
    workstreams.update(ws.id, {
      codex_thread_id: thread.id,
      state: sm.initialState,
    });

    // Log event
    eventLog.emit({
      workstream_id: ws.id,
      project_id: params.projectId,
      event_type: "workstream.created",
      payload: {
        name: params.name,
        threadId: thread.id,
        cwd: workspace.cwd,
        branch: workspace.branch,
        baseBranch: resolvedBaseBranch ?? null,
        epicId: params.epicId ?? null,
        workspaceMode: workspace.mode,
      },
      source: "orchestrator",
    });

    eventBus.emit("workstream.created", {
      workstreamId: ws.id,
      projectId: params.projectId,
      name: params.name,
    });

    log.info({ workstreamId: ws.id, project: params.projectId }, "Workstream created");
    return workstreams.getById(ws.id)!;
  }

  async dispatch(workstreamId: string, instruction: string) {
    let ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);
    const planningContext = parsePlanningContextRecord(ws.planning_context_json);
    if (planningContext?.status === "needs-answers") {
      throw new Error(
        `Dispatch is blocked for "${ws.name}" because planning still has unresolved questions. Answer them with /workstream answer-plan or start a fresh /workstream plan.`
      );
    }
    if (planningContext?.status === "needs-final-prompt") {
      throw new Error(
        `Dispatch is blocked for "${ws.name}" because planning has no final execution prompt yet. Start a fresh /workstream plan or resume the current flow explicitly.`
      );
    }

    if (ws.state === "planning") {
      ws = this.tryTransitionState(ws, "plan-approved", { allowAutoPlan: false });
    }

    const dispatchWorkstream = await this.prepareWorkstreamForDispatch(ws);
    const adapter = this.getAdapter(dispatchWorkstream.project_id);
    const preparedInstruction = this.prepareTurnInstruction(dispatchWorkstream, instruction);
    const executionInstruction = this.buildExecutionInstruction(
      dispatchWorkstream,
      instruction,
      preparedInstruction.instruction
    );

    // Create turn record
    const turn = turns.create({
      workstream_id: workstreamId,
      instruction,
    });
    this.activeTurnByWorkstream.set(workstreamId, turn.id);
    const startedAt = new Date().toISOString();
    this.beginActiveOperation(workstreamId, "implementation", startedAt);

    turns.update(turn.id, {
      status: "running",
      started_at: startedAt,
      last_progress_at: startedAt,
    });

    workstreams.update(workstreamId, { current_goal: instruction });

    eventBus.emit("turn.started", {
      workstreamId,
      turnId: turn.id,
      instruction,
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: dispatchWorkstream.project_id,
      event_type: "turn.started",
      payload: {
        turnId: turn.id,
        instruction,
        epicId: dispatchWorkstream.epic_id ?? null,
        epicContextInjected: preparedInstruction.epicContextInjected,
      },
      source: "orchestrator",
    });

    // Execute (async — returns when done)
    try {
      const result = await adapter.startTurn({
        threadId: dispatchWorkstream.codex_thread_id!,
        instruction: executionInstruction,
        cwd: dispatchWorkstream.cwd ?? this.getProject(dispatchWorkstream.project_id).repoPath,
      });

      // Update turn
      const completedAt = new Date().toISOString();
      turns.update(turn.id, {
        codex_turn_id: result.backendTurnId,
        status: result.status,
        result_summary: result.summary,
        last_progress_at: completedAt,
        completed_at: completedAt,
      });

      // Update workstream summary
      workstreams.update(workstreamId, {
        summary: result.summary,
      });
      this.persistOperatorReport(
        dispatchWorkstream,
        this.buildDispatchOperatorReport(dispatchWorkstream, turn.id, result),
      );

      eventBus.emit("turn.completed", {
        workstreamId,
        turnId: turn.id,
        status: result.status,
        summary: result.summary,
        output: result.output,
      });

      eventLog.emit({
        workstream_id: workstreamId,
        project_id: dispatchWorkstream.project_id,
        event_type: "turn.completed",
        payload: {
          turnId: turn.id,
          status: result.status,
          summary: result.summary ?? null,
          output: result.output,
        },
        source: "orchestrator",
      });

      const startedAutoVerification = this.maybeStartAutoVerification(dispatchWorkstream, turn.id, result.status);
      if (!startedAutoVerification) {
        this.maybeStartAutoClaudeReview(dispatchWorkstream, turn.id, result.status);
      }
      this.activeTurnByWorkstream.delete(workstreamId);
      this.completeActiveOperation(workstreamId);
      log.info({ workstreamId, turnId: turn.id, status: result.status }, "Turn completed");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const completedAt = new Date().toISOString();

      turns.update(turn.id, {
        status: "failed",
        result_summary: message,
        last_progress_at: completedAt,
        completed_at: completedAt,
      });
      this.persistOperatorReport(
        dispatchWorkstream,
        this.buildDispatchOperatorReport(dispatchWorkstream, turn.id, {
          status: "failed",
          output: message,
          summary: message,
        }),
      );

      eventBus.emit("turn.completed", {
        workstreamId,
        turnId: turn.id,
        status: "failed",
        summary: message,
        output: message,
      });

      eventBus.emit("error", {
        workstreamId,
        error: err instanceof Error ? err : new Error(message),
        context: `Turn execution failed: ${instruction.slice(0, 100)}`,
      });

      this.activeTurnByWorkstream.delete(workstreamId);
      this.completeActiveOperation(workstreamId);
      throw err;
    }
  }

  async steer(workstreamId: string, instruction: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws?.codex_thread_id) throw new Error(`Workstream not found or no thread: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    await adapter.steerTurn({ threadId: ws.codex_thread_id, instruction });
    this.touchProgress("implementation", workstreamId);

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "turn.steered",
      payload: { instruction },
      source: "orchestrator",
    });
  }

  async cancel(workstreamId: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws?.codex_thread_id) throw new Error(`Workstream not found or no thread: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    await adapter.interruptTurn(ws.codex_thread_id);
    const cancelledTurns = this.markRunningTurnsCancelled(workstreamId, "Cancelled by user.");
    const expiredApprovals = approvals.expirePendingByWorkstream(workstreamId, "cancel");
    this.completeActiveOperation(workstreamId);

    workstreams.update(workstreamId, { current_goal: null, waiting_on_approval: 0, pending_decision: null });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "turn.cancelled",
      payload: { expiredApprovals, cancelledTurns },
      source: "orchestrator",
    });
  }

  async archive(workstreamId: string, archivedBy = "system") {
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    if (ws.state === "done") {
      return ws;
    }

    const activeTurnId = this.activeTurnByWorkstream.get(workstreamId);
    if (activeTurnId && ws.codex_thread_id) {
      const adapter = this.getAdapter(ws.project_id);
      await adapter.interruptTurn(ws.codex_thread_id);
    }

    const cancelledTurns = this.markRunningTurnsCancelled(workstreamId, `Archived by ${archivedBy}`);
    this.completeActiveOperation(workstreamId);

    const expiredApprovals = approvals.expirePendingByWorkstream(workstreamId, archivedBy);

    workstreams.update(workstreamId, {
      state: "done",
      current_goal: null,
      waiting_on_approval: 0,
      pending_decision: null,
      completed_at: new Date().toISOString(),
    });

    eventBus.emit("workstream.stateChanged", {
      workstreamId,
      from: ws.state,
      to: "done",
      trigger: "archived",
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "workstream.archived",
      payload: {
        archivedBy,
        previousState: ws.state,
        interruptedActiveTurn: Boolean(activeTurnId),
        cancelledTurns,
        expiredApprovals,
      },
      source: "orchestrator",
    });

    log.info(
      { workstreamId, projectId: ws.project_id, archivedBy, interruptedActiveTurn: Boolean(activeTurnId) },
      "Workstream archived"
    );

    return workstreams.getById(workstreamId)!;
  }

  async transitionState(workstreamId: string, trigger: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    const updated = this.forceTransitionState(ws, trigger);
    const newState = updated.state;
    log.info({ workstreamId, from: ws.state, to: newState, trigger }, "State transitioned");
    return newState;
  }

  async review(
    workstreamId: string,
    target?: string,
    options?: { reviewer?: "primary" | "claude"; trigger?: "manual" | "auto" }
  ) {
    const reviewer = options?.reviewer ?? "primary";
    const ws = workstreams.getById(workstreamId);
    if (!ws) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    if (reviewer === "primary" && !ws.codex_thread_id) {
      throw new Error(`Workstream not found or no thread: ${workstreamId}`);
    }

    const effectiveTarget = target ?? "uncommitted";
    const latestTurn = turns.listByWorkstream(ws.id).slice(-1)[0] ?? null;
    this.beginActiveOperation(workstreamId, "review");
    try {
      const result =
        reviewer === "claude"
          ? await this.runClaudeReview(ws, effectiveTarget, latestTurn?.id ?? null)
          : await this.getAdapter(ws.project_id).startReview({
              threadId: ws.codex_thread_id!,
              cwd: ws.cwd ?? this.getProject(ws.project_id).repoPath,
              target: effectiveTarget,
            });

      this.touchProgress("review", workstreamId, latestTurn?.id ?? undefined);
      this.persistOperatorReport(
        ws,
        this.buildReviewOperatorReport(ws, latestTurn?.id ?? null, result, reviewer, effectiveTarget),
      );

      eventLog.emit({
        workstream_id: workstreamId,
        project_id: ws.project_id,
        event_type: "review.completed",
        payload: {
          severity: result.severity,
          findingsLength: result.findings.length,
          reviewer,
          trigger: options?.trigger ?? "manual",
        },
        source: "orchestrator",
      });

      if (reviewer === "claude") {
        eventBus.emit("review.completed", {
          workstreamId,
          reviewer: "claude",
          severity: result.severity,
          findings: result.findings,
          suggestions: result.suggestions ?? [],
          target: effectiveTarget,
        });
      }

      return result;
    } finally {
      this.completeActiveOperation(workstreamId);
    }
  }

  async verify(
    workstreamId: string,
    options?: {
      trigger?: VerificationRunTrigger;
      sourceTurnId?: string | null;
    }
  ): Promise<{
    verificationContext: VerificationContextRecord;
    renderedVerification: string;
  }> {
    let workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const project = this.getProject(workstream.project_id);
    const verificationConfig = project.claudeVerification;
    if (!verificationConfig?.enabled) {
      throw new Error(`Claude verification is disabled for project ${project.id}.`);
    }

    if (workstream.state === "implementation") {
      workstream = this.tryTransitionState(workstream, "implementation-complete", { allowAutoPlan: false });
    }

    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const previousContext = parseVerificationContextRecord(workstream.verification_context_json);
    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    const latestTurn =
      (options?.sourceTurnId ? turns.getById(options.sourceTurnId) : undefined) ??
      turns.listByWorkstream(workstream.id).slice(-1)[0] ??
      null;
    const epicContextAnalysis = await this.getAgentEpicContextAnalysis(workstream, verificationConfig.model);
    this.beginActiveOperation(workstreamId, "verification");
    try {
      const agentResult = await runAgent(
        adapter,
        "verification",
        {
          projectId: project.id,
          repoPath: project.repoPath,
          workstreamId: workstream.id,
          workstreamName: workstream.name,
          workstreamState: workstream.state,
          instruction: [
            "Verify the current workstream changes and determine whether they are ready for review.",
            latestTurn?.instruction ? `Latest implementation instruction: ${latestTurn.instruction}` : null,
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
          cwd,
          addDirs: [cwd],
          epicCharter: this.getEpicCharterContext(workstream),
          agentsMd: this.readAgentsMd(project),
          extra: {
            "Latest Turn Summary": latestTurn?.result_summary ?? workstream.summary ?? "No turn summary recorded.",
            "Latest Turn Output": this.getLatestTurnOutput(
              workstream.id,
              latestTurn?.result_summary ?? workstream.summary ?? "",
            ),
            "Git Status": this.readGitOutput(["status", "--short", "--branch"], cwd),
            "Git Diff": this.readGitReviewDiff(cwd, "uncommitted"),
            "Structured Intake": planningContext?.intake ? renderIntakeMarkdown(planningContext.intake) : "None.",
            "Goal Frame": planningContext?.goalFrame ? renderGoalFrameMarkdown(planningContext.goalFrame) : "None.",
            "System Model": planningContext?.modeling ? renderModelingMarkdown(planningContext.modeling) : "None.",
            "Test Design": planningContext?.testDesign ? renderTestDesignMarkdown(planningContext.testDesign) : "None.",
            "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
          },
        },
        {
          threadId: previousContext?.verificationThreadId ?? undefined,
          model: verificationConfig.model,
          maxTurns: 8,
          permissionMode: "auto",
          onOutput: this.buildOperationOutputHandler("verification", workstream.id, latestTurn?.id ?? null),
        },
      );

      if (agentResult.status !== "completed") {
        throw new Error(agentResult.output || "Claude verification failed.");
      }

      const verificationResult = coerceVerificationResult(agentResult.structured, agentResult.output);
      let verificationContext = buildVerificationContextRecord({
        result: verificationResult,
        rawAgentOutput: agentResult.output,
        verificationThreadId: agentResult.threadId,
        sourceTurnId: latestTurn?.id ?? options?.sourceTurnId ?? null,
        trigger: options?.trigger ?? "manual",
        previous: previousContext,
      });
      if (verificationResult.status === "fail" && verificationResult.introducedFailures.length > 0) {
        verificationContext = {
          ...verificationContext,
          incidentTriage: await this.runVerificationIncidentTriage(
            workstream,
            latestTurn?.instruction ?? workstream.current_goal ?? "No recorded implementation instruction.",
            verificationContext,
            planningContext,
            verificationConfig.model,
            epicContextAnalysis,
          ),
        };
      }
      const renderedVerification = this.persistVerificationContext(
        workstream,
        verificationContext,
        options?.trigger ?? "manual",
      );
      this.touchProgress("verification", workstream.id, latestTurn?.id ?? undefined);
      this.persistOperatorReport(
        workstream,
        this.buildVerificationOperatorReport(workstream, latestTurn?.id ?? null, verificationContext),
      );
      const updatedWorkstream = workstreams.getById(workstream.id) ?? workstream;

      if (
        verificationResult.status === "pass" &&
        (options?.trigger ?? "manual") === "auto"
      ) {
        this.maybeStartAutoClaudeReviewAfterVerification(updatedWorkstream, latestTurn?.id ?? null);
      }

      return {
        verificationContext,
        renderedVerification,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
    }
  }

  async generateBrief(options?: {
    trigger?: BriefTrigger;
    requestedBy?: string;
    channelId?: string | null;
  }): Promise<GeneratedBrief> {
    if (!this.config.brief.enabled) {
      throw new Error("Claude brief generation is disabled in config.brief.enabled.");
    }

    if (this.briefInFlight) {
      throw new Error("A Claude brief is already running.");
    }

    const promise = this.generateBriefInternal({
      trigger: options?.trigger ?? "manual",
      requestedBy: options?.requestedBy ?? "system",
      channelId: options?.channelId ?? this.config.brief.discordChannelId ?? this.config.discord.defaultNotificationChannelId ?? null,
    });

    this.briefInFlight = promise;
    try {
      return await promise;
    } finally {
      this.briefInFlight = null;
    }
  }

  async generatePlan(
    workstreamId: string,
    instruction: string,
    trigger: Exclude<PlanningRunTrigger, "resume"> = "manual",
    options: GeneratePlanOptions = {},
  ): Promise<GeneratedPlanResult> {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const project = this.getProject(workstream.project_id);
    const planningConfig = project.claudePlanning;
    if (!planningConfig?.enabled) {
      throw new Error(`Claude planning is disabled for project ${project.id}.`);
    }

    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const storedContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (options.resumeExisting && !storedContext) {
      throw new Error(`Workstream ${workstreamId} has no stored planning context to resume.`);
    }
    if (
      options.resumeExisting &&
      storedContext &&
      instruction.trim() !== storedContext.originalInstruction.trim()
    ) {
      throw new Error(
        `Resume uses the existing planning instruction "${storedContext.originalInstruction}". Start a fresh /workstream plan to change it.`
      );
    }
    const previousContext = options.resumeExisting ? storedContext : null;
    const effectiveInstruction = previousContext?.originalInstruction ?? instruction;
    const epicContextAnalysis = await this.getAgentEpicContextAnalysis(workstream, planningConfig.model);
    this.beginActiveOperation(workstreamId, "planning");
    try {
      const intake =
        previousContext?.intake ??
        await this.runPlanningIntake(workstream, effectiveInstruction, planningConfig.model, epicContextAnalysis);
      const goalFrame =
        previousContext?.goalFrame ??
        await this.runPlanningGoalFrame(workstream, effectiveInstruction, intake, planningConfig.model, epicContextAnalysis);
      const modeling =
        previousContext?.modeling ??
        await this.runPlanningModeling(workstream, effectiveInstruction, intake, goalFrame, planningConfig.model, epicContextAnalysis);
      const testDesign =
        previousContext?.testDesign ??
        await this.runPlanningTestDesign(
          workstream,
          effectiveInstruction,
          intake,
          goalFrame,
          modeling,
          planningConfig.model,
          epicContextAnalysis,
        );
      const agentResult = await runAgent(
        adapter,
        "planning",
        this.buildPlanningAgentContext(
          workstream,
          effectiveInstruction,
          intake,
          goalFrame,
          modeling,
          testDesign,
          previousContext,
          undefined,
          epicContextAnalysis,
        ),
        {
          threadId: previousContext?.planningThreadId ?? undefined,
          model: planningConfig.model,
          maxTurns: 6,
          permissionMode: "plan",
          onOutput: this.buildOperationOutputHandler("planning", workstream.id),
        },
      );

      if (agentResult.status !== "completed") {
        throw new Error(agentResult.output || "Claude plan generation failed.");
      }

      const planningResult = parsePlanningResult(agentResult.structured, agentResult.output);
      const basePlanningContext = buildPlanningContextRecord({
        originalInstruction: effectiveInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        intake,
        goalFrame,
        modeling,
        testDesign,
        planningThreadId: agentResult.threadId,
        previous: previousContext,
      });
      const feedbackRequest = await this.runPlanningFeedbackRequest(
        workstream,
        effectiveInstruction,
        basePlanningContext,
        planningConfig.model,
        epicContextAnalysis,
      );
      const explanation = await this.runPlanningExplanation(
        workstream,
        effectiveInstruction,
        basePlanningContext,
        feedbackRequest,
        planningConfig.model,
        epicContextAnalysis,
      );
      const planningContext = buildPlanningContextRecord({
        originalInstruction: effectiveInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        intake,
        goalFrame,
        modeling,
        testDesign,
        feedbackRequest,
        explanation,
        planningThreadId: agentResult.threadId,
        previous: previousContext,
      });

      const renderedPlan = this.persistPlanningContext(workstream, effectiveInstruction, planningContext, trigger);
      this.touchProgress("planning", workstream.id);
      this.persistOperatorReport(
        workstream,
        this.buildPlanOperatorReport(workstream, planningContext, trigger),
      );
      return {
        renderedPlan,
        planningContext,
        finalExecutionPrompt: planningContext.finalExecutionPrompt,
        needsAnswers: planningContext.pendingQuestions.length > 0,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
    }
  }

  getPlanningContext(workstreamId: string): PlanningContextRecord | null {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      return null;
    }

    return parsePlanningContextRecord(workstream.planning_context_json);
  }

  async provideDecisionAnswers(
    workstreamId: string,
    answers: Record<string, string>,
    answeredBy?: string,
  ): Promise<GeneratedPlanResult> {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const existingContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (!existingContext) {
      throw new Error(`Workstream ${workstreamId} has no stored planning context to resume.`);
    }

    this.beginActiveOperation(workstreamId, "planning");
    try {
      const { mergedAnswers, appliedIds, unknownIds } = mergePlanningAnswers(existingContext, answers, {
        answeredBy: answeredBy ?? null,
      });

      if (appliedIds.length === 0) {
        const suffix =
          unknownIds.length > 0
            ? ` Unknown question ids: ${unknownIds.join(", ")}.`
            : "";
        throw new Error(`No planning answers matched the current pending questions.${suffix}`);
      }

      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "plan.answersProvided",
        payload: {
          answerIds: appliedIds,
          answeredBy: answeredBy ?? null,
        },
        source: "orchestrator",
      });

      const project = this.getProject(workstream.project_id);
      const planningConfig = project.claudePlanning;
      if (!planningConfig?.enabled) {
        throw new Error(`Claude planning is disabled for project ${project.id}.`);
      }

      const adapter = await this.getUtilityClaudeAdapter();
      const epicContextAnalysis = await this.getAgentEpicContextAnalysis(workstream, planningConfig.model);
      const intake =
        existingContext.intake ??
        await this.runPlanningIntake(workstream, existingContext.originalInstruction, planningConfig.model, epicContextAnalysis);
      const goalFrame =
        existingContext.goalFrame ??
        await this.runPlanningGoalFrame(
          workstream,
          existingContext.originalInstruction,
          intake,
          planningConfig.model,
          epicContextAnalysis,
        );
      const modeling =
        existingContext.modeling ??
        await this.runPlanningModeling(
          workstream,
          existingContext.originalInstruction,
          intake,
          goalFrame,
          planningConfig.model,
          epicContextAnalysis,
        );
      const testDesign =
        existingContext.testDesign ??
        await this.runPlanningTestDesign(
          workstream,
          existingContext.originalInstruction,
          intake,
          goalFrame,
          modeling,
          planningConfig.model,
          epicContextAnalysis,
        );
      const agentResult = await runAgent(
        adapter,
        "planning",
        this.buildPlanningAgentContext(
          workstream,
          existingContext.originalInstruction,
          intake,
          goalFrame,
          modeling,
          testDesign,
          existingContext,
          mergedAnswers,
          epicContextAnalysis,
        ),
        {
          threadId: existingContext.planningThreadId ?? undefined,
          model: planningConfig.model,
          maxTurns: 6,
          permissionMode: "plan",
          onOutput: this.buildOperationOutputHandler("planning", workstream.id),
        },
      );

      if (agentResult.status !== "completed") {
        throw new Error(agentResult.output || "Claude planning resume failed.");
      }

      const planningResult = parsePlanningResult(agentResult.structured, agentResult.output);
      const basePlanningContext = buildPlanningContextRecord({
        originalInstruction: existingContext.originalInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        intake,
        goalFrame,
        modeling,
        testDesign,
        planningThreadId: agentResult.threadId,
        answers: mergedAnswers,
        previous: existingContext,
      });
      const feedbackRequest = await this.runPlanningFeedbackRequest(
        workstream,
        existingContext.originalInstruction,
        basePlanningContext,
        planningConfig.model,
        epicContextAnalysis,
      );
      const explanation = await this.runPlanningExplanation(
        workstream,
        existingContext.originalInstruction,
        basePlanningContext,
        feedbackRequest,
        planningConfig.model,
        epicContextAnalysis,
      );
      const planningContext = buildPlanningContextRecord({
        originalInstruction: existingContext.originalInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        intake,
        goalFrame,
        modeling,
        testDesign,
        feedbackRequest,
        explanation,
        planningThreadId: agentResult.threadId,
        answers: mergedAnswers,
        previous: existingContext,
      });

      const renderedPlan = this.persistPlanningContext(
        workstream,
        existingContext.originalInstruction,
        planningContext,
        "resume",
      );
      this.touchProgress("planning", workstream.id);
      this.persistOperatorReport(
        workstream,
        this.buildPlanOperatorReport(workstream, planningContext, "resume"),
      );

      return {
        renderedPlan,
        planningContext,
        finalExecutionPrompt: planningContext.finalExecutionPrompt,
        needsAnswers: planningContext.pendingQuestions.length > 0,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
    }
  }

  // --- Query methods ---

  getWorkstream(id: string) {
    return workstreams.getById(id);
  }

  listActiveWorkstreams() {
    return workstreams.listActive();
  }

  listProjectWorkstreams(projectId: string) {
    return workstreams.listByProject(projectId);
  }

  listChannelWorkstreams(channelId: string, options?: { includeArchived?: boolean }) {
    const channelWorkstreams = workstreams.listByDiscordChannel(channelId);
    if (options?.includeArchived) {
      return channelWorkstreams;
    }

    return channelWorkstreams.filter((workstream) => workstream.state !== "done");
  }

  getChannelWorkstream(channelId: string) {
    const channelWorkstreams = this.listChannelWorkstreams(channelId);
    if (channelWorkstreams.length === 0) {
      return null;
    }

    if (channelWorkstreams.length === 1) {
      return channelWorkstreams[0];
    }

    return null;
  }

  getWorkstreamTurns(workstreamId: string) {
    return turns.listByWorkstream(workstreamId);
  }

  getWorkstreamStatusSnapshot(workstreamId: string): WorkstreamStatusSnapshot | null {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      return null;
    }

    const latestTurn = this.getLatestStatusTurn(workstream.id);
    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    const verificationContext = parseVerificationContextRecord(workstream.verification_context_json);
    const latestReport = this.getLatestOperatorReport(workstream.id);
    const pendingApprovalCount = approvals.listPending(workstream.id).length;
    const activeOperation = this.getActiveOperationSnapshot(workstream, latestTurn);
    const nextAction = this.computeNextAction(workstream, planningContext, verificationContext, latestReport, activeOperation);
    const { health, reason } = this.computeHealth(
      workstream,
      planningContext,
      verificationContext,
      latestTurn,
      latestReport,
      activeOperation,
      pendingApprovalCount,
    );

    return {
      workstreamId: workstream.id,
      workstreamName: workstream.name,
      projectId: workstream.project_id,
      epicId: workstream.epic_id,
      state: workstream.state,
      branch: workstream.branch,
      workspace: workstream.cwd,
      codexThreadId: workstream.codex_thread_id,
      currentGoal: workstream.current_goal,
      waitingOnApproval: Boolean(workstream.waiting_on_approval) || pendingApprovalCount > 0,
      pendingApprovalCount,
      health,
      healthReason: reason,
      planning: {
        status: planningContext?.status ?? "none",
        pendingQuestionCount: planningContext?.pendingQuestions.length ?? 0,
        finalPromptReady: Boolean(planningContext?.finalExecutionPrompt),
      },
      verification: {
        status: verificationContext?.result.status ?? "none",
        recommendation: verificationContext?.result.recommendation ?? null,
        introducedFailureCount: verificationContext?.result.introducedFailures.length ?? 0,
      },
      latestTurn,
      latestReport,
      activeOperation,
      nextAction,
      generatedAt: new Date().toISOString(),
    };
  }

  getPendingApprovals(workstreamId?: string) {
    return approvals.listPending(workstreamId);
  }

  async resolveApproval(approvalId: string, approved: boolean, decidedBy = "http") {
    const approval = approvals.getById(approvalId);
    if (!approval) {
      throw new Error(`Approval not found: ${approvalId}`);
    }

    const ws = workstreams.getById(approval.workstream_id);
    if (!ws?.codex_thread_id) {
      throw new Error(`Workstream not found or no thread for approval: ${approvalId}`);
    }

    const adapter = this.getAdapter(ws.project_id);
    const backendApprovalId = this.extractBackendApprovalId(approval);
    try {
      await adapter.resolveApproval(ws.codex_thread_id, backendApprovalId, approved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Unknown approval request")) {
        throw new Error(
          "This approval request is stale in the current Maverick session. Cancel or archive the workstream, then dispatch again to generate a fresh approval."
        );
      }
      throw error;
    }

    const status = approved ? "approved" : "denied";
    const resolved = approvals.resolve(approval.id, status, decidedBy);
    this.touchProgress("implementation", ws.id);

    const stillPending = approvals.listPending(ws.id);
    if (stillPending.length === 0) {
      workstreams.update(ws.id, {
        waiting_on_approval: 0,
        pending_decision: this.planningPendingDecisionForWorkstream(workstreams.getById(ws.id)),
      });
    }

    eventBus.emit("approval.resolved", {
      workstreamId: ws.id,
      approvalId: approval.id,
      status,
      decidedBy,
    });

    eventLog.emit({
      workstream_id: ws.id,
      project_id: ws.project_id,
      event_type: "approval.resolved",
      payload: { approvalId: approval.id, status, decidedBy },
      source: "orchestrator",
    });

    return resolved;
  }

  getRecentEvents(limit?: number) {
    return eventLog.listRecent(limit);
  }

  getProjectStatus(projectId: string) {
    const project = this.getProject(projectId);
    const ws = workstreams.listByProject(projectId);
    const active = ws.filter(w => w.state !== "done");
    const pending = approvals.listPending();
    const projectApprovals = pending.filter(a =>
      ws.some(w => w.id === a.workstream_id)
    );

    return {
      project,
      bootstrap: this.projectBootstrap.get(projectId) ?? null,
      workstreams: ws,
      activeCount: active.length,
      pendingApprovals: projectApprovals.length,
      states: Object.fromEntries(
        active.map(w => [w.name, w.state])
      ),
    };
  }

  getHealthStatus() {
    return {
      status: this.initialized ? "ok" : "starting",
      initialized: this.initialized,
      projects: this.config.projects.map((project) => ({
        id: project.id,
        name: project.name,
        repoPath: project.repoPath,
        backend: this.adapters.get(project.id)?.name ?? "uninitialized",
        bootstrapCreatedFiles: this.projectBootstrap.get(project.id)?.createdFiles.length ?? 0,
      })),
      activeWorkstreams: workstreams.listActive().length,
      pendingApprovals: approvals.listPending().length,
      timestamp: new Date().toISOString(),
    };
  }

  private beginActiveOperation(
    workstreamId: string,
    kind: ActiveOperationKind,
    startedAt = new Date().toISOString(),
  ): void {
    this.activeOperationByWorkstream.set(workstreamId, {
      kind,
      startedAt,
      lastProgressAt: startedAt,
    });
  }

  private completeActiveOperation(workstreamId: string): void {
    this.activeOperationByWorkstream.delete(workstreamId);
  }

  private buildOperationOutputHandler(
    kind: ActiveOperationKind,
    workstreamId: string,
    turnId?: string | null,
  ): (content: string, isPartial: boolean) => void {
    return () => {
      this.touchProgress(kind, workstreamId, turnId ?? undefined);
    };
  }

  private touchProgress(
    kind: ActiveOperationKind,
    workstreamId: string,
    turnId?: string,
    at = new Date().toISOString(),
  ): void {
    const activeOperation = this.activeOperationByWorkstream.get(workstreamId);
    if (activeOperation) {
      this.activeOperationByWorkstream.set(workstreamId, {
        ...activeOperation,
        kind,
        lastProgressAt: at,
      });
    } else {
      this.activeOperationByWorkstream.set(workstreamId, {
        kind,
        startedAt: at,
        lastProgressAt: at,
      });
    }

    const resolvedTurnId = turnId ?? this.activeTurnByWorkstream.get(workstreamId);
    if (resolvedTurnId) {
      this.touchTurnProgress(resolvedTurnId, at);
    }
  }

  private touchTurnProgress(turnId: string, at = new Date().toISOString()): void {
    turns.update(turnId, {
      last_progress_at: at,
    });
  }

  private getLatestStatusTurn(workstreamId: string): StatusLatestTurn | null {
    const turn = turns.listByWorkstream(workstreamId).slice(-1)[0] ?? null;
    if (!turn) {
      return null;
    }

    return {
      id: turn.id,
      status: turn.status,
      instruction: turn.instruction,
      resultSummary: turn.result_summary,
      startedAt: turn.started_at,
      lastProgressAt: turn.last_progress_at,
      completedAt: turn.completed_at,
    };
  }

  private getLatestOperatorReport(workstreamId: string): OperatorReportArtifactMetadata | null {
    const artifact = artifacts.getLatestByWorkstream(workstreamId, "operator-report");
    if (!artifact?.metadata_json) {
      return null;
    }

    return this.parseOperatorReportMetadata(artifact.metadata_json);
  }

  private parseOperatorReportMetadata(metadataJson: string | null): OperatorReportArtifactMetadata | null {
    if (!metadataJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
      const kind = parsed.kind;
      if (kind !== "plan" && kind !== "dispatch" && kind !== "verification" && kind !== "review") {
        return null;
      }

      const validation = Array.isArray(parsed.validation)
        ? parsed.validation.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return [];
            }

            const candidate = entry as Record<string, unknown>;
            const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
            const detail = typeof candidate.detail === "string" ? candidate.detail.trim() : "";
            const status = candidate.status;
            if (!label || !detail) {
              return [];
            }

            if (
              status !== "pass" &&
              status !== "fail" &&
              status !== "warning" &&
              status !== "info" &&
              status !== "skipped"
            ) {
              return [];
            }

            return [{
              label,
              detail,
              status,
              command: typeof candidate.command === "string" ? candidate.command.trim() : undefined,
            } satisfies OperatorValidationEvidence];
          })
        : [];

      return {
        schemaVersion: typeof parsed.schemaVersion === "number" ? Math.max(1, Math.trunc(parsed.schemaVersion)) : 1,
        kind,
        headline: typeof parsed.headline === "string" ? parsed.headline.trim() : "Operator report",
        summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
        filesChanged: Array.isArray(parsed.filesChanged)
          ? parsed.filesChanged.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : [],
        validation,
        remainingRisks: Array.isArray(parsed.remainingRisks)
          ? parsed.remainingRisks.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : [],
        nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction.trim() : "Monitor the workstream.",
        sourceEvent: typeof parsed.sourceEvent === "string" ? parsed.sourceEvent.trim() : "unknown",
        generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt.trim() : new Date().toISOString(),
        turnId: typeof parsed.turnId === "string" && parsed.turnId.length > 0 ? parsed.turnId : null,
      };
    } catch {
      return null;
    }
  }

  private persistOperatorReport(
    workstream: WorkstreamRow,
    metadata: OperatorReportArtifactMetadata,
  ): ArtifactRow {
    return artifacts.create({
      workstream_id: workstream.id,
      turn_id: metadata.turnId,
      type: "operator-report",
      name: `${metadata.kind}-operator-report`,
      content: this.renderOperatorReportMarkdown(metadata),
      metadata_json: JSON.stringify(metadata),
    });
  }

  private renderOperatorReportMarkdown(report: OperatorReportArtifactMetadata): string {
    return [
      `# ${report.headline}`,
      "",
      `Summary: ${report.summary}`,
      `Generated: ${report.generatedAt}`,
      `Source event: ${report.sourceEvent}`,
      report.filesChanged.length > 0
        ? ["", "## Files Changed", ...report.filesChanged.map((file) => `- ${file}`)].join("\n")
        : null,
      report.validation.length > 0
        ? ["", "## Validation Evidence", ...report.validation.map((entry) => {
            const commandSuffix = entry.command ? ` via \`${entry.command}\`` : "";
            return `- [${entry.status}] ${entry.label}: ${entry.detail}${commandSuffix}`;
          })].join("\n")
        : null,
      report.remainingRisks.length > 0
        ? ["", "## Remaining Risks", ...report.remainingRisks.map((risk) => `- ${risk}`)].join("\n")
        : null,
      "",
      `## Next Action`,
      report.nextAction,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private buildPlanOperatorReport(
    workstream: WorkstreamRow,
    planningContext: PlanningContextRecord,
    trigger: PlanningRunTrigger,
  ): OperatorReportArtifactMetadata {
    return {
      schemaVersion: 1,
      kind: "plan",
      headline:
        planningContext.status === "needs-answers"
          ? "Planning is waiting on operator input"
          : planningContext.finalExecutionPrompt
            ? "Planning is ready to dispatch"
            : "Planning stored structured analysis",
      summary:
        planningContext.status === "needs-answers"
          ? `Planning surfaced ${planningContext.pendingQuestions.length} operator answer(s) before dispatch is safe.`
          : planningContext.finalExecutionPrompt
            ? "Planning produced a final Codex execution prompt for the next implementation slice."
            : "Planning stored structured analysis, but the final execution prompt still needs refinement.",
      filesChanged: Array.from(
        new Set(planningContext.result.steps.flatMap((step) => step.files)),
      ),
      validation: [
        {
          label: "Planning readiness",
          status:
            planningContext.status === "needs-answers"
              ? "warning"
              : planningContext.finalExecutionPrompt
                ? "pass"
                : "info",
          detail:
            planningContext.status === "needs-answers"
              ? `${planningContext.pendingQuestions.length} operator answer(s) remain.`
              : planningContext.finalExecutionPrompt
                ? "Final execution prompt stored."
                : "Structured context stored without a final execution prompt yet.",
        },
      ],
      remainingRisks: Array.from(
        new Set([...planningContext.result.risks, ...planningContext.result.remainingUnknowns]),
      ),
      nextAction:
        planningContext.status === "needs-answers"
          ? "Answer the pending planning questions."
          : planningContext.finalExecutionPrompt
            ? "Dispatch the next implementation step using the stored execution prompt."
            : "Resume planning and finalize the execution prompt before dispatch.",
      sourceEvent: `plan.generated:${trigger}`,
      generatedAt: new Date().toISOString(),
      turnId: null,
    };
  }

  private buildDispatchOperatorReport(
    workstream: WorkstreamRow,
    turnId: string,
    result: Pick<import("../codex/types.js").TurnResult, "status" | "summary" | "output">,
  ): OperatorReportArtifactMetadata {
    const autoVerificationEnabled = Boolean(this.getProject(workstream.project_id).claudeVerification?.enabled);
    const validationStatus = result.status === "completed" ? "info" : "fail";
    return {
      schemaVersion: 1,
      kind: "dispatch",
      headline:
        result.status === "completed"
          ? "Implementation turn completed"
          : result.status === "cancelled"
            ? "Implementation turn was cancelled"
            : "Implementation turn failed",
      summary: result.summary?.trim() || result.output.trim() || `Turn finished with status ${result.status}.`,
      filesChanged: this.collectWorkspaceChangedFiles(workstream),
      validation: [
        {
          label: "Implementation turn",
          status: validationStatus,
          detail: result.summary?.trim() || `Turn finished with status ${result.status}.`,
        },
        ...(result.status === "completed" && autoVerificationEnabled
          ? [{
              label: "Follow-up verification",
              status: "info",
              detail: "Claude verification is available for this project.",
            } satisfies OperatorValidationEvidence]
          : []),
      ],
      remainingRisks:
        result.status === "completed"
          ? []
          : ["Implementation did not finish cleanly, so verification evidence is incomplete."],
      nextAction:
        result.status !== "completed"
          ? "Inspect the failed turn output and decide whether to retry or steer the workstream."
          : autoVerificationEnabled
            ? "Run or wait for verification before treating this slice as review-ready."
            : "Verify the changes before moving to review.",
      sourceEvent: "turn.completed",
      generatedAt: new Date().toISOString(),
      turnId,
    };
  }

  private buildVerificationOperatorReport(
    workstream: WorkstreamRow,
    turnId: string | null,
    verificationContext: VerificationContextRecord,
  ): OperatorReportArtifactMetadata {
    return {
      schemaVersion: 1,
      kind: "verification",
      headline:
        verificationContext.result.status === "pass"
          ? "Verification passed"
          : "Verification found introduced failures",
      summary:
        verificationContext.result.status === "pass"
          ? "All required verification checks passed for the current slice."
          : `${verificationContext.result.introducedFailures.length} introduced failure(s) need attention before review.`,
      filesChanged: this.collectWorkspaceChangedFiles(workstream),
      validation: verificationContext.result.checks.map((check) => ({
        label: check.name,
        status: check.status === "pass"
          ? "pass"
          : check.status === "skipped"
            ? "skipped"
            : "fail",
        detail: check.output || check.status,
        command: check.command,
      })),
      remainingRisks: Array.from(
        new Set([
          ...verificationContext.result.introducedFailures,
          ...(verificationContext.incidentTriage?.escalationReason ? [verificationContext.incidentTriage.escalationReason] : []),
        ]),
      ),
      nextAction:
        verificationContext.result.status === "pass"
          ? "Review the workstream and decide whether to ship."
          : verificationContext.incidentTriage?.escalationNeeded
            ? "Inspect the verification incident triage and resolve the escalated blocker."
            : "Fix the introduced verification failures and rerun verification.",
      sourceEvent: `verification.completed:${verificationContext.trigger}`,
      generatedAt: new Date().toISOString(),
      turnId,
    };
  }

  private buildReviewOperatorReport(
    workstream: WorkstreamRow,
    turnId: string | null,
    result: ReviewResult & { verdict?: string },
    reviewer: "primary" | "claude",
    target: string,
  ): OperatorReportArtifactMetadata {
    const reviewStatus: OperatorValidationEvidence["status"] =
      result.severity === "clean"
        ? "pass"
        : result.severity === "minor"
          ? "warning"
          : "fail";
    return {
      schemaVersion: 1,
      kind: "review",
      headline: reviewer === "claude" ? "Claude review completed" : "Primary review completed",
      summary: result.findings.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "Review completed.",
      filesChanged: this.collectWorkspaceChangedFiles(workstream),
      validation: [
        {
          label: "Review severity",
          status: reviewStatus,
          detail: `Severity ${result.severity} on target ${target} via ${reviewer}.`,
        },
      ],
      remainingRisks: Array.from(
        new Set([
          ...(result.suggestions ?? []),
          ...this.extractNarrativeBullets(result.findings, 4),
        ]),
      ),
      nextAction:
        result.severity === "clean"
          ? "Ship or merge when you are ready."
          : result.severity === "minor"
            ? "Review the caveats and decide whether to ship or follow up."
            : "Address the review findings before shipping.",
      sourceEvent: `review.completed:${reviewer}`,
      generatedAt: new Date().toISOString(),
      turnId,
    };
  }

  private collectWorkspaceChangedFiles(workstream: WorkstreamRow): string[] {
    const cwd = workstream.cwd ?? this.getProject(workstream.project_id).repoPath;
    const statusOutput = this.readGitOutput(["status", "--short"], cwd);
    if (!statusOutput || statusOutput.startsWith("Git command failed")) {
      return [];
    }

    return statusOutput
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).split(" -> ").slice(-1)[0]?.trim() ?? "")
      .filter((line) => line.length > 0);
  }

  private extractNarrativeBullets(text: string, limit: number): string[] {
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 0 && !line.startsWith("Verdict:") && !line.startsWith("Passes:"))
      .slice(0, limit);
  }

  private getActiveOperationSnapshot(
    workstream: WorkstreamRow,
    latestTurn: StatusLatestTurn | null,
  ): ActiveOperationSnapshot | null {
    const explicit = this.activeOperationByWorkstream.get(workstream.id);
    if (explicit) {
      return {
        kind: explicit.kind,
        startedAt: explicit.startedAt,
        lastProgressAt: explicit.lastProgressAt,
        quiet: Date.now() - new Date(explicit.lastProgressAt).getTime() >= QUIET_HEALTH_THRESHOLD_MS,
      };
    }

    if (latestTurn?.status === "running") {
      const startedAt = latestTurn.startedAt ?? latestTurn.lastProgressAt ?? new Date().toISOString();
      const lastProgressAt = latestTurn.lastProgressAt ?? startedAt;
      return {
        kind: "implementation",
        startedAt,
        lastProgressAt,
        quiet: Date.now() - new Date(lastProgressAt).getTime() >= QUIET_HEALTH_THRESHOLD_MS,
      };
    }

    return null;
  }

  private computeHealth(
    workstream: WorkstreamRow,
    planningContext: PlanningContextRecord | null,
    verificationContext: VerificationContextRecord | null,
    latestTurn: StatusLatestTurn | null,
    latestReport: OperatorReportArtifactMetadata | null,
    activeOperation: ActiveOperationSnapshot | null,
    pendingApprovalCount: number,
  ): { health: WorkstreamHealth; reason: string | null } {
    if (workstream.state === "done") {
      return { health: "done", reason: "Workstream is archived or completed." };
    }

    if (workstream.state === "blocked") {
      return { health: "blocked", reason: "Workstream is in the blocked state." };
    }

    if (Boolean(workstream.waiting_on_approval) || pendingApprovalCount > 0) {
      return {
        health: "waiting-on-approval",
        reason: `${pendingApprovalCount || 1} approval request(s) are pending.`,
      };
    }

    if (planningContext?.status === "needs-answers") {
      return {
        health: "awaiting-input",
        reason: `Planning is waiting on ${planningContext.pendingQuestions.length} operator answer(s).`,
      };
    }

    if (activeOperation?.quiet) {
      return {
        health: "quiet",
        reason: `${activeOperation.kind} has been quiet since ${activeOperation.lastProgressAt}.`,
      };
    }

    if (activeOperation) {
      return {
        health: "running",
        reason: `${activeOperation.kind} is active.`,
      };
    }

    if (latestTurn?.status === "failed") {
      return {
        health: "failed",
        reason: latestTurn.resultSummary ?? "The latest implementation turn failed.",
      };
    }

    if (verificationContext?.result.status === "fail") {
      return {
        health: "failed",
        reason: `${verificationContext.result.introducedFailures.length} introduced verification failure(s) remain.`,
      };
    }

    if (
      workstream.state === "review" &&
      verificationContext?.result.status === "pass" &&
      (!latestReport || latestReport.kind !== "review" || latestReport.validation[0]?.status !== "fail")
    ) {
      return {
        health: "ready-for-review",
        reason: "Verification passed and the workstream is waiting in review.",
      };
    }

    return {
      health: "idle",
      reason: workstream.summary ?? null,
    };
  }

  private computeNextAction(
    workstream: WorkstreamRow,
    planningContext: PlanningContextRecord | null,
    verificationContext: VerificationContextRecord | null,
    latestReport: OperatorReportArtifactMetadata | null,
    activeOperation: ActiveOperationSnapshot | null,
  ): string {
    const pendingApprovalCount = approvals.listPending(workstream.id).length;
    if (Boolean(workstream.waiting_on_approval) || pendingApprovalCount > 0) {
      return "Resolve the pending approval request.";
    }

    if (planningContext?.status === "needs-answers") {
      return "Answer the pending planning questions.";
    }

    if (planningContext?.status === "needs-final-prompt") {
      return "Resume planning and finalize the execution prompt before dispatch.";
    }

    if (activeOperation?.quiet) {
      return "Inspect the quiet run and decide whether to steer, cancel, or wait longer.";
    }

    if (verificationContext?.result.status === "fail") {
      return "Fix the introduced verification failures and rerun verification.";
    }

    if (
      latestReport?.kind === "review" &&
      (
        latestReport.validation.some((entry) => entry.status === "fail" || entry.status === "warning") ||
        latestReport.remainingRisks.length > 0
      )
    ) {
      return "Address the review findings before shipping.";
    }

    if (latestReport?.kind === "dispatch") {
      return latestReport.nextAction;
    }

    if (workstream.state === "review") {
      return "Review the latest verification evidence and decide whether to ship.";
    }

    if (planningContext?.finalExecutionPrompt || workstream.state === "implementation" || workstream.state === "planning") {
      return "Dispatch the next implementation step.";
    }

    return latestReport?.nextAction ?? "Monitor the workstream.";
  }

  // --- Internal ---

  private maybeStartAutoClaudeReview(workstream: WorkstreamRow, turnId: string, turnStatus: string): void {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    const verificationConfig = project.claudeVerification;
    const primaryAdapter = this.getAdapter(workstream.project_id);

    if (
      !reviewConfig?.enabled ||
      !reviewConfig.autoAfterTurn ||
      turnStatus !== "completed" ||
      (verificationConfig?.enabled && verificationConfig.autoAfterTurn) ||
      !primaryAdapter.name.startsWith("codex")
    ) {
      return;
    }

    void this.review(workstream.id, "uncommitted", {
      reviewer: "claude",
      trigger: "auto",
    }).catch((error) => {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: `Claude auto-review failed for turn ${turnId}`,
      });
    });
  }

  private maybeStartAutoVerification(workstream: WorkstreamRow, turnId: string, turnStatus: string): boolean {
    const project = this.getProject(workstream.project_id);
    const verificationConfig = project.claudeVerification;
    const primaryAdapter = this.getAdapter(workstream.project_id);

    if (
      !verificationConfig?.enabled ||
      !verificationConfig.autoAfterTurn ||
      turnStatus !== "completed" ||
      !primaryAdapter.name.startsWith("codex")
    ) {
      return false;
    }

    void this.verify(workstream.id, {
      trigger: "auto",
      sourceTurnId: turnId,
    }).catch((error) => {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: `Claude auto-verification failed for turn ${turnId}`,
      });
    });

    return true;
  }

  private maybeStartAutoClaudePlan(workstream: WorkstreamRow): void {
    const project = this.getProject(workstream.project_id);
    const planningConfig = project.claudePlanning;
    if (
      workstream.state !== "planning" ||
      !planningConfig?.enabled ||
      !planningConfig.autoOnPlanningState
    ) {
      return;
    }

    const instruction = workstream.current_goal ?? workstream.description ?? workstream.name;
    void this.generatePlan(workstream.id, instruction, "auto").catch((error) => {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: "Claude auto-plan failed while entering planning state",
      });
    });
  }

  private buildExecutionInstruction(
    workstream: WorkstreamRow,
    userInstruction: string,
    baseInstruction = userInstruction
  ): string {
    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (
      planningContext?.finalExecutionPrompt &&
      workstream.current_goal === planningContext.originalInstruction &&
      workstream.current_goal === userInstruction
    ) {
      return planningContext.finalExecutionPrompt;
    }

    if (!workstream.plan || workstream.current_goal !== userInstruction) {
      return baseInstruction;
    }

    return [
      "Approved implementation plan:",
      workstream.plan,
      "",
      "Execute the following instruction using the stored plan above as the primary guide:",
      baseInstruction,
    ].join("\n");
  }

  private async runClaudeReview(
    workstream: WorkstreamRow,
    target: string,
    sourceTurnId: string | null,
  ): Promise<ReviewResult & { verdict?: string }> {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    if (!reviewConfig?.enabled) {
      throw new Error(`Claude review is disabled for project ${project.id}.`);
    }

    const cwd = workstream.cwd ?? project.repoPath;
    const latestTurn = turns.listByWorkstream(workstream.id).slice(-1)[0] ?? null;
    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    const verificationContext = parseVerificationContextRecord(workstream.verification_context_json);
    const adapter = await this.getUtilityClaudeAdapter();
    const epicContextAnalysis = await this.getAgentEpicContextAnalysis(workstream, reviewConfig.model);
    const agentResult = await runAgent(
      adapter,
      "review",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: latestTurn?.instruction ?? workstream.current_goal ?? "No recorded instruction.",
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Review Target": target,
          "Turn Summary": latestTurn?.result_summary ?? workstream.summary ?? "No turn summary recorded.",
          "Turn Output": this.getLatestTurnOutput(
            workstream.id,
            latestTurn?.result_summary ?? workstream.summary ?? "",
          ),
          "Git Status": this.readGitOutput(["status", "--short", "--branch"], cwd),
          "Git Diff": this.readGitReviewDiff(cwd, target),
          "Relevant Test Results": verificationContext
            ? renderVerificationSummary(verificationContext)
            : "No structured test results captured yet.",
          "System Model": planningContext?.modeling ? renderModelingMarkdown(planningContext.modeling) : "No stored system model.",
          "Test Design": planningContext?.testDesign ? renderTestDesignMarkdown(planningContext.testDesign) : "No stored test design.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model: reviewConfig.model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("review", workstream.id, sourceTurnId),
      },
    );

    if (agentResult.status !== "completed") {
      throw new Error(agentResult.output || "Claude review failed.");
    }

    this.touchProgress("review", workstream.id, sourceTurnId ?? undefined);
    const reviewResult = coerceReviewAgentResult(agentResult.structured, agentResult.output) as ReviewResult & { verdict?: string };
    const verdict =
      agentResult.structured && typeof agentResult.structured.verdict === "string"
        ? agentResult.structured.verdict.trim()
        : undefined;
    if (verdict) {
      reviewResult.verdict = verdict;
    }
    return reviewResult;
  }

  private async generateBriefInternal(params: {
    trigger: BriefTrigger;
    requestedBy: string;
    channelId: string | null;
  }): Promise<GeneratedBrief> {
    const collector = new BriefCollector(this.config);
    const context = await collector.collect();
    const adapter = await this.getUtilityClaudeAdapter();
    const repoPaths = [...new Set(this.config.projects.map((project) => project.repoPath))];
    const cwd = repoPaths[0] ?? process.cwd();
    const agentResult = await runAgent(
      adapter,
      "brief",
      {
        projectId: "maverick-brief",
        repoPath: cwd,
        instruction: "Generate the daily operational brief from the provided control-plane context.",
        cwd,
        addDirs: repoPaths,
        extra: {
          "Brief Context JSON": JSON.stringify(context, null, 2),
        },
      },
      {
        model: this.config.brief.model,
        maxTurns: 10,
        permissionMode: "auto",
      },
    );

    if (agentResult.status !== "completed") {
      throw new Error(agentResult.output || "Claude brief generation failed.");
    }

    const content = renderBriefContent(coerceBriefAgentResult(agentResult.structured, agentResult.output), agentResult.output).trim();
    if (!content) {
      throw new Error("Claude returned an empty brief.");
    }

    const markdown = renderBriefMarkdown({
      trigger: params.trigger,
      generatedAt: context.generatedAt,
      content,
      context,
    });
    const storagePath = this.persistBrief(markdown, context.generatedAt);
    const summary = summarizeBrief(content);

    eventLog.emit({
      event_type: "brief.generated",
      payload: {
        trigger: params.trigger,
        requestedBy: params.requestedBy,
        storagePath,
        summary,
      },
      source: "orchestrator",
    });

    eventBus.emit("brief.generated", {
      trigger: params.trigger,
      generatedAt: context.generatedAt,
      content,
      markdown,
      summary,
      storagePath,
      channelId: params.channelId,
    });

    return {
      generatedAt: context.generatedAt,
      trigger: params.trigger,
      content,
      markdown,
      storagePath,
      channelId: params.channelId,
      summary,
    };
  }

  private startBriefScheduler(): void {
    if (!this.config.brief.enabled || !this.config.brief.schedule || this.briefTimer) {
      return;
    }

    const timeZone = this.config.assistant.timeZone;
    this.briefTimer = setInterval(() => {
      if (!this.initialized) {
        return;
      }

      const now = new Date();
      try {
        if (!cronMatchesDate(this.config.brief.schedule!, now, timeZone)) {
          return;
        }
      } catch (error) {
        log.warn({ err: error, schedule: this.config.brief.schedule }, "Invalid brief schedule");
        return;
      }

      const minuteKey = scheduledMinuteKey(now, timeZone);
      if (minuteKey === this.lastBriefScheduleKey) {
        return;
      }

      this.lastBriefScheduleKey = minuteKey;
      void this.generateBrief({
        trigger: "schedule",
        requestedBy: "scheduler",
        channelId: this.config.brief.discordChannelId ?? this.config.discord.defaultNotificationChannelId ?? null,
      }).catch((error) => {
        log.warn({ err: error }, "Scheduled brief generation failed");
      });
    }, 60_000);

    this.briefTimer.unref?.();
    log.info(
      { schedule: this.config.brief.schedule, timeZone },
      "Claude brief scheduler started"
    );
  }

  private persistBrief(markdown: string, generatedAt: string): string {
    const storageRoot = resolve(this.config.brief.storagePath);
    mkdirSync(storageRoot, { recursive: true });
    const outputPath = join(storageRoot, briefFilename(generatedAt));
    writeFileSync(outputPath, markdown, "utf8");
    return outputPath;
  }

  private async getUtilityClaudeAdapter(): Promise<ExecutionBackendAdapter> {
    if (this.utilityClaudeAdapter) {
      return this.utilityClaudeAdapter;
    }

    const configured =
      this.config.projects
        .map((project) => project.executionBackend)
        .find((backend): backend is NonNullable<ProjectConfig["executionBackend"]> => backend?.type === "claude-code") ??
      (this.config.defaults.executionBackend.type === "claude-code" ? this.config.defaults.executionBackend : null) ??
      {
        type: "claude-code" as const,
        model: "sonnet",
        claudePath: process.env.CLAUDE_PATH,
        permissionMode: "plan" as const,
        maxTurns: 10,
      };

    this.utilityClaudeAdapter = createAdapter(configured);
    await this.utilityClaudeAdapter.initialize();
    return this.utilityClaudeAdapter;
  }

  private async getAgentEpicContextAnalysis(
    workstream: WorkstreamRow,
    model?: string,
  ): Promise<string | null> {
    if (!workstream.epic_id) {
      return null;
    }

    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const siblingWorkstreams = workstreams
      .listByProject(project.id)
      .filter((candidate) => candidate.epic_id === workstream.epic_id)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        state: candidate.state,
        summary: candidate.summary,
        lastActivityAt: candidate.last_activity_at,
      }));
    const siblingIds = new Set(siblingWorkstreams.map((candidate) => candidate.id));
    const recentEpicEvents = eventLog
      .listRecent(50)
      .filter((event) => event.workstream_id && siblingIds.has(event.workstream_id))
      .map((event) => ({
        workstreamId: event.workstream_id,
        eventType: event.event_type,
        createdAt: event.created_at,
      }));
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "epic-context",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: `Summarize the current durable and operational context for epic ${workstream.epic_id}.`,
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Epic Workstreams": JSON.stringify(siblingWorkstreams, null, 2),
          "Recent Epic Events": JSON.stringify(recentEpicEvents, null, 2),
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
      },
    );

    if (agentResult.status !== "completed") {
      return null;
    }

    return renderEpicContextAnalysis(agentResult.structured, agentResult.output);
  }

  private async runPlanningIntake(
    workstream: WorkstreamRow,
    instruction: string,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<IntakeResult> {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const recentTurns = turns.listByWorkstream(workstream.id).slice(-5).map((turn) => ({
      instruction: turn.instruction,
      status: turn.status,
      summary: turn.result_summary,
    }));
    const agentResult = await runAgent(
      adapter,
      "intake",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Scope this workstream request against the current repo state.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Directory Tree": this.buildDirectoryTree(cwd),
          "Recent Turn History": JSON.stringify(recentTurns, null, 2),
          "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
          "Stored Plan Summary": workstream.plan ?? "No stored plan summary.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 6,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    if (agentResult.status !== "completed") {
      throw new Error(agentResult.output || "Claude intake generation failed.");
    }

    this.touchProgress("planning", workstream.id);
    return parseIntakeResult(agentResult.structured, instruction);
  }

  private async runPlanningGoalFrame(
    workstream: WorkstreamRow,
    instruction: string,
    intake: IntakeResult,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<GoalFrameResult> {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "goal-framing",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Turn the scoped intake result into a durable execution frame for this workstream.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Structured Intake": renderIntakeMarkdown(intake),
          "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
          "Stored Plan Summary": workstream.plan ?? "No stored plan summary.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    if (agentResult.status !== "completed") {
      throw new Error(agentResult.output || "Claude goal framing failed.");
    }

    this.touchProgress("planning", workstream.id);
    return parseGoalFrameResult(agentResult.structured, intake);
  }

  private async runPlanningModeling(
    workstream: WorkstreamRow,
    instruction: string,
    intake: IntakeResult,
    goalFrame: GoalFrameResult,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<ModelingResult> {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "modeling",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Model the part of the system that matters for this workstream.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Structured Intake": renderIntakeMarkdown(intake),
          "Goal Frame": renderGoalFrameMarkdown(goalFrame),
          "Directory Tree": this.buildDirectoryTree(cwd),
          "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    this.touchProgress("planning", workstream.id);
    return parseModelingResult(
      agentResult.status === "completed" ? agentResult.structured : null,
      goalFrame.problemStatement || intake.scope || instruction,
    );
  }

  private async runPlanningTestDesign(
    workstream: WorkstreamRow,
    instruction: string,
    intake: IntakeResult,
    goalFrame: GoalFrameResult,
    modeling: ModelingResult,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<TestDesignResult> {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "test-design",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Create test-first execution prep for this workstream.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Structured Intake": renderIntakeMarkdown(intake),
          "Goal Frame": renderGoalFrameMarkdown(goalFrame),
          "System Model": renderModelingMarkdown(modeling),
          "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    this.touchProgress("planning", workstream.id);
    return parseTestDesignResult(
      agentResult.status === "completed" ? agentResult.structured : null,
      goalFrame.successCriteria[0] ?? intake.acceptanceCriteria[0] ?? instruction,
    );
  }

  private async runPlanningFeedbackRequest(
    workstream: WorkstreamRow,
    instruction: string,
    planningContext: PlanningContextRecord,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<OperatorFeedbackResult | null> {
    if (planningContext.pendingQuestions.length === 0) {
      return null;
    }

    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "operator-feedback",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Turn the pending planning questions into a stronger operator questionnaire.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Structured Intake": planningContext.intake ? renderIntakeMarkdown(planningContext.intake) : "None.",
          "Goal Frame": planningContext.goalFrame ? renderGoalFrameMarkdown(planningContext.goalFrame) : "None.",
          "System Model": planningContext.modeling ? renderModelingMarkdown(planningContext.modeling) : "None.",
          "Test Design": planningContext.testDesign ? renderTestDesignMarkdown(planningContext.testDesign) : "None.",
          "Pending Planning Questions": JSON.stringify(planningContext.pendingQuestions, null, 2),
          "Recommended Next Slice": planningContext.result.recommendedNextSlice,
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    this.touchProgress("planning", workstream.id);
    return coerceOperatorFeedbackResult(
      agentResult.status === "completed" ? agentResult.structured : null,
      planningContext.pendingQuestions,
    );
  }

  private async runPlanningExplanation(
    workstream: WorkstreamRow,
    instruction: string,
    planningContext: PlanningContextRecord,
    feedbackRequest: OperatorFeedbackResult | null,
    model?: string,
    epicContextAnalysis?: string | null,
  ): Promise<ExplanationResult> {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "response-formatting",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Format the current planning state into concise Discord-friendly Markdown.",
          `Operator instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Structured Intake": planningContext.intake ? renderIntakeMarkdown(planningContext.intake) : "None.",
          "Goal Frame": planningContext.goalFrame ? renderGoalFrameMarkdown(planningContext.goalFrame) : "None.",
          "System Model": planningContext.modeling ? renderModelingMarkdown(planningContext.modeling) : "None.",
          "Test Design": planningContext.testDesign ? renderTestDesignMarkdown(planningContext.testDesign) : "None.",
          "Planning Summary": renderPlanningSummary(planningContext),
          "Operator Feedback Request": renderOperatorFeedbackMarkdown(feedbackRequest),
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 4,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("planning", workstream.id),
      },
    );

    this.touchProgress("planning", workstream.id);
    return coerceExplanationResult(
      agentResult.status === "completed" ? agentResult.structured : null,
      planningContext,
      feedbackRequest,
    );
  }

  private buildPlanningAgentContext(
    workstream: WorkstreamRow,
    instruction: string,
    intake: IntakeResult | null,
    goalFrame: GoalFrameResult | null,
    modeling: ModelingResult | null,
    testDesign: TestDesignResult | null,
    previousContext?: PlanningContextRecord | null,
    answers?: Record<string, PlanningAnswer>,
    epicContextAnalysis?: string | null,
  ) {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const recentTurns = turns.listByWorkstream(workstream.id).slice(-5).map((turn) => ({
      instruction: turn.instruction,
      status: turn.status,
      summary: turn.result_summary,
    }));

    return {
      projectId: project.id,
      repoPath: project.repoPath,
      workstreamId: workstream.id,
      workstreamName: workstream.name,
      workstreamState: workstream.state,
      instruction: previousContext
        ? [
            "Resume the stored planning flow for this workstream.",
            "Incorporate any recorded operator answers from the context sections below.",
            "Only keep questions in requiredAnswers or importantDecisions if they are still unresolved after considering those answers.",
            "",
            `Original operator instruction: ${instruction}`,
          ].join("\n")
        : [
            "Analyze this workstream and produce a structured, decision-gated plan for Codex.",
            `Operator instruction: ${instruction}`,
          ].join("\n"),
      cwd,
      addDirs: [cwd],
      epicCharter: this.getEpicCharterContext(workstream),
      agentsMd: this.readAgentsMd(project),
      extra: {
        "Directory Tree": this.buildDirectoryTree(cwd),
        "Recent Turn History": JSON.stringify(recentTurns, null, 2),
        "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
        "Stored Plan Summary": workstream.plan ?? "No stored plan summary.",
        "Structured Intake": intake ? renderIntakeMarkdown(intake) : "None.",
        "Goal Frame": goalFrame ? renderGoalFrameMarkdown(goalFrame) : "None.",
        "System Model": modeling ? renderModelingMarkdown(modeling) : "None.",
        "Test Design": testDesign ? renderTestDesignMarkdown(testDesign) : "None.",
        "Previous Planning Context": previousContext ? JSON.stringify(previousContext, null, 2) : "None.",
        "Operator Answers": serializePlanningAnswers(answers ?? previousContext?.answers ?? {}),
        "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
      },
    };
  }

  private persistPlanningContext(
    workstream: WorkstreamRow,
    instruction: string,
    planningContext: PlanningContextRecord,
    trigger: PlanningRunTrigger,
  ): string {
    const renderedPlan = renderPlanningSummary(planningContext);
    const formattedMarkdown = planningContext.explanation?.markdown ?? renderedPlan;
    const needsAnswers = planningContext.pendingQuestions.length > 0;
    const summary =
      planningContext.status === "needs-answers"
        ? `Planning is waiting on ${planningContext.pendingQuestions.length} operator answer${planningContext.pendingQuestions.length === 1 ? "" : "s"}.`
        : planningContext.finalExecutionPrompt
          ? "Planning produced a final Codex execution prompt."
          : "Planning stored structured analysis, but no final execution prompt is ready yet.";
    const pendingDecision =
      planningContext.status === "needs-answers"
        ? JSON.stringify({
            source: "planning",
            status: "needs-answers",
            questions: planningContext.pendingQuestions,
          })
        : planningContext.status === "needs-final-prompt"
          ? JSON.stringify({
              source: "planning",
              status: "needs-final-prompt",
              description: "Planning has no final execution prompt yet.",
            })
          : null;

    workstreams.update(workstream.id, {
      current_goal: instruction,
      pending_decision: pendingDecision,
      planning_context_json: JSON.stringify(planningContext),
      plan: renderedPlan,
      summary,
    });
    this.syncPlanningWorkflowState(workstreams.getById(workstream.id) ?? workstream, planningContext);

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "plan.generated",
      payload: {
        trigger,
        instruction,
        needsAnswers,
        pendingQuestionCount: planningContext.pendingQuestions.length,
        finalPromptReady: Boolean(planningContext.finalExecutionPrompt),
      },
      source: "orchestrator",
    });

    eventBus.emit("plan.generated", {
      workstreamId: workstream.id,
      trigger,
      instruction,
      renderedPlan,
      formattedMarkdown,
      finalExecutionPrompt: planningContext.finalExecutionPrompt,
      needsAnswers,
    });

    if (needsAnswers) {
      eventBus.emit("decision.needed", {
        workstreamId: workstream.id,
        trigger,
        instruction,
        questions: planningContext.pendingQuestions,
        renderedPlan,
        formattedMarkdown,
      });
    }

    return renderedPlan;
  }

  private syncPlanningWorkflowState(
    workstream: WorkstreamRow,
    planningContext: PlanningContextRecord,
  ): WorkstreamRow {
    let current = workstream;

    if (current.state === "intake") {
      current = this.tryTransitionState(current, "scope-defined", { allowAutoPlan: false });
    }

    if (planningContext.pendingQuestions.length > 0 && current.state === "planning") {
      return this.tryTransitionState(current, "operator-input-required", { allowAutoPlan: false });
    }

    if (planningContext.pendingQuestions.length === 0 && current.state === "awaiting-decisions") {
      return this.tryTransitionState(current, "operator-input-received", { allowAutoPlan: false });
    }

    return workstreams.getById(workstream.id) ?? current;
  }

  private persistVerificationContext(
    workstream: WorkstreamRow,
    verificationContext: VerificationContextRecord,
    trigger: VerificationRunTrigger,
  ): string {
    const renderedVerification = renderVerificationSummary(verificationContext);
    const statusSummary =
      verificationContext.result.status === "pass"
        ? "Verification passed and the workstream is ready for review."
        : verificationContext.incidentTriage
          ? [
              `Verification found ${verificationContext.result.introducedFailures.length} introduced failure${verificationContext.result.introducedFailures.length === 1 ? "" : "s"}.`,
              `Incident triage: ${verificationContext.incidentTriage.suggestedFix}`,
            ].join(" ")
          : `Verification found ${verificationContext.result.introducedFailures.length} introduced failure${verificationContext.result.introducedFailures.length === 1 ? "" : "s"}.`;
    const continuationInstruction =
      verificationContext.result.status === "fail" &&
      verificationContext.incidentTriage &&
      !verificationContext.incidentTriage.escalationNeeded
        ? buildIncidentContinuationInstruction(verificationContext.incidentTriage)
        : undefined;

    workstreams.update(workstream.id, {
      verification_context_json: JSON.stringify(verificationContext),
      current_goal: continuationInstruction,
      summary: statusSummary,
    });

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "verification.completed",
      payload: {
        trigger,
        status: verificationContext.result.status,
        recommendation: verificationContext.result.recommendation,
        introducedFailureCount: verificationContext.result.introducedFailures.length,
        triaged: Boolean(verificationContext.incidentTriage),
      },
      source: "orchestrator",
    });

    eventBus.emit("verification.completed", {
      workstreamId: workstream.id,
      trigger,
      status: verificationContext.result.status,
      recommendation: verificationContext.result.recommendation,
      renderedVerification,
    });

    let updated = workstreams.getById(workstream.id) ?? workstream;
    if (updated.state === "verification") {
      updated = this.tryTransitionState(
        updated,
        verificationContext.result.status === "pass" ? "verification-passed" : "verification-failed",
        { allowAutoPlan: false },
      );
    }

    return renderedVerification;
  }

  private async runVerificationIncidentTriage(
    workstream: WorkstreamRow,
    instruction: string,
    verificationContext: VerificationContextRecord,
    planningContext: PlanningContextRecord | null,
    model?: string,
    epicContextAnalysis?: string | null,
  ) {
    const project = this.getProject(workstream.project_id);
    const cwd = workstream.cwd ?? project.repoPath;
    const adapter = await this.getUtilityClaudeAdapter();
    const agentResult = await runAgent(
      adapter,
      "incident-triage",
      {
        projectId: project.id,
        repoPath: project.repoPath,
        workstreamId: workstream.id,
        workstreamName: workstream.name,
        workstreamState: workstream.state,
        instruction: [
          "Diagnose the introduced verification failures and decide the best next continuation move.",
          `Latest implementation instruction: ${instruction}`,
        ].join("\n"),
        cwd,
        addDirs: [cwd],
        epicCharter: this.getEpicCharterContext(workstream),
        agentsMd: this.readAgentsMd(project),
        extra: {
          "Verification Report": renderVerificationSummary(verificationContext),
          "Incident Trigger": verificationContext.result.introducedFailures.join("\n"),
          "Git Status": this.readGitOutput(["status", "--short", "--branch"], cwd),
          "Git Diff": this.readGitReviewDiff(cwd, "uncommitted"),
          "Structured Intake": planningContext?.intake ? renderIntakeMarkdown(planningContext.intake) : "None.",
          "Goal Frame": planningContext?.goalFrame ? renderGoalFrameMarkdown(planningContext.goalFrame) : "None.",
          "System Model": planningContext?.modeling ? renderModelingMarkdown(planningContext.modeling) : "None.",
          "Test Design": planningContext?.testDesign ? renderTestDesignMarkdown(planningContext.testDesign) : "None.",
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model,
        maxTurns: 6,
        permissionMode: "plan",
        onOutput: this.buildOperationOutputHandler("verification", workstream.id, verificationContext.sourceTurnId),
      },
    );

    this.touchProgress("verification", workstream.id, verificationContext.sourceTurnId ?? undefined);
    return coerceIncidentTriageResult(
      agentResult.status === "completed" ? agentResult.structured : null,
      agentResult.output,
    );
  }

  private maybeStartAutoClaudeReviewAfterVerification(
    workstream: WorkstreamRow,
    sourceTurnId: string | null,
  ): void {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    const primaryAdapter = this.getAdapter(workstream.project_id);

    if (!reviewConfig?.enabled || !reviewConfig.autoAfterTurn || !primaryAdapter.name.startsWith("codex")) {
      return;
    }

    void this.review(workstream.id, "uncommitted", {
      reviewer: "claude",
      trigger: "auto",
    }).catch((error) => {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: `Claude auto-review failed after verification${sourceTurnId ? ` for turn ${sourceTurnId}` : ""}`,
      });
    });
  }

  private forceTransitionState(
    workstream: WorkstreamRow,
    trigger: string,
    options: { allowAutoPlan?: boolean } = {},
  ): WorkstreamRow {
    const sm = this.getStateMachine(workstream.project_id);
    const newState = sm.transition(workstream.state, trigger);
    return this.commitStateTransition(workstream, newState, trigger, options);
  }

  private tryTransitionState(
    workstream: WorkstreamRow,
    trigger: string,
    options: { allowAutoPlan?: boolean } = {},
  ): WorkstreamRow {
    const sm = this.getStateMachine(workstream.project_id);
    const transition = sm.canTransition(workstream.state, trigger);
    if (!transition.allowed) {
      return workstreams.getById(workstream.id) ?? workstream;
    }

    return this.commitStateTransition(workstream, transition.to, trigger, options);
  }

  private commitStateTransition(
    workstream: WorkstreamRow,
    newState: string,
    trigger: string,
    options: { allowAutoPlan?: boolean } = {},
  ): WorkstreamRow {
    if (newState === workstream.state) {
      return workstreams.getById(workstream.id) ?? workstream;
    }

    const sm = this.getStateMachine(workstream.project_id);
    workstreams.update(workstream.id, {
      state: newState,
      completed_at: sm.isTerminal(newState) ? new Date().toISOString() : undefined,
    });

    eventBus.emit("workstream.stateChanged", {
      workstreamId: workstream.id,
      from: workstream.state,
      to: newState,
      trigger,
    });

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.stateChanged",
      payload: { from: workstream.state, to: newState, trigger },
      source: "orchestrator",
    });

    const updated = workstreams.getById(workstream.id) ?? { ...workstream, state: newState };
    if (options.allowAutoPlan !== false) {
      this.maybeStartAutoClaudePlan(updated);
    }

    return updated;
  }

  private planningPendingDecisionForWorkstream(workstream: WorkstreamRow | undefined): string | null {
    if (!workstream) {
      return null;
    }

    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (!planningContext) {
      return null;
    }

    if (planningContext.status === "needs-answers") {
      return JSON.stringify({
        source: "planning",
        status: "needs-answers",
        questions: planningContext.pendingQuestions,
      });
    }

    if (planningContext.status === "needs-final-prompt") {
      return JSON.stringify({
        source: "planning",
        status: "needs-final-prompt",
        description: "Planning has no final execution prompt yet.",
      });
    }

    return null;
  }

  private getLatestTurnOutput(workstreamId: string, fallback: string): string {
    const completionEvent = eventLog
      .listByWorkstream(workstreamId, 20)
      .find((event) => event.event_type === "turn.completed");
    if (!completionEvent) {
      return fallback;
    }

    try {
      const payload = JSON.parse(completionEvent.payload_json) as Record<string, unknown>;
      return typeof payload.output === "string" && payload.output.length > 0 ? payload.output : fallback;
    } catch {
      return fallback;
    }
  }

  private readGitReviewDiff(cwd: string, target: string): string {
    if (target === "branch-diff") {
      return this.readGitOutput(["diff", "--no-color", "main...HEAD"], cwd);
    }

    if (/^[a-f0-9]{7,40}$/i.test(target)) {
      return this.readGitOutput(["show", "--no-color", target], cwd);
    }

    return this.readGitOutput(["diff", "--no-color"], cwd);
  }

  private readGitOutput(args: string[], cwd: string): string {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      }).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Git command failed (${args.join(" ")}): ${message}`;
    }
  }

  private readAgentsMd(project: ProjectConfig): string {
    const agentsMdPath = project.agentsMdPath ?? join(project.repoPath, "AGENTS.md");
    try {
      return readFileSync(agentsMdPath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Unable to read AGENTS.md at ${agentsMdPath}: ${message}`;
    }
  }

  private buildDirectoryTree(rootPath: string, maxEntries = 120): string {
    const lines: string[] = [];

    const visit = (currentPath: string, depth: number) => {
      if (lines.length >= maxEntries || depth > 2) {
        return;
      }

      const entries = readdirSync(currentPath, { withFileTypes: true })
        .filter((entry) => ![".git", "node_modules", "dist", ".generated"].includes(entry.name))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));

      for (const entry of entries) {
        if (lines.length >= maxEntries) {
          return;
        }

        const entryPath = join(currentPath, entry.name);
        const label = `${"  ".repeat(depth)}- ${entry.name}${entry.isDirectory() ? "/" : ""}`;
        lines.push(label);
        if (entry.isDirectory()) {
          visit(entryPath, depth + 1);
        }
      }
    };

    try {
      visit(rootPath, 0);
      return lines.join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Unable to read directory tree for ${rootPath}: ${message}`;
    }
  }

  private async handleApprovalRequest(workstreamId: string, request: ApprovalRequest) {
    const ws = workstreams.getById(workstreamId);
    if (!ws) return;

    // Determine tier based on escalation rules
    const tier = this.classifyApproval(ws, request);

    const approval = approvals.create({
      workstream_id: workstreamId,
      type: request.type,
      description: request.description,
      context_json: JSON.stringify(request.context),
      tier,
    });
    this.touchProgress("implementation", workstreamId);

    workstreams.update(workstreamId, {
      waiting_on_approval: 1,
      pending_decision: JSON.stringify({ approvalId: approval.id, description: request.description }),
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "approval.requested",
      payload: { approvalId: approval.id, type: request.type, tier },
      source: "codex",
    });

    if (tier === "auto") {
      // Auto-approve
      approvals.resolve(approval.id, "approved", "auto");
      workstreams.update(workstreamId, {
        waiting_on_approval: 0,
        pending_decision: this.planningPendingDecisionForWorkstream(workstreams.getById(workstreamId)),
      });

      const adapter = this.getAdapter(ws.project_id);
      await adapter.resolveApproval(ws.codex_thread_id!, request.id, true);

      eventBus.emit("approval.resolved", {
        workstreamId,
        approvalId: approval.id,
        status: "approved",
        decidedBy: "auto",
      });
      this.touchProgress("implementation", workstreamId);

      eventLog.emit({
        workstream_id: workstreamId,
        project_id: ws.project_id,
        event_type: "approval.resolved",
        payload: { approvalId: approval.id, status: "approved", decidedBy: "auto" },
        source: "orchestrator",
      });
    } else {
      // Emit for Discord/HTTP to handle
      eventBus.emit("approval.requested", {
        workstreamId,
        approvalId: approval.id,
        type: request.type,
        description: request.description,
        tier,
      });
    }
  }

  private classifyApproval(workstream: WorkstreamRow, request: ApprovalRequest): EscalationTier {
    const project = this.getProject(workstream.project_id);
    const rules = project.escalationRules ?? this.config.defaults.escalationRules;
    const contextText = this.buildApprovalContextText(request);

    const explicitHumanDecision = rules.find(
      (rule) => rule.tier === "human-decision" && contextText.includes(rule.pattern.replace(/\*/g, ""))
    );
    if (explicitHumanDecision || HUMAN_DECISION_PATTERNS.some((pattern) => pattern.test(contextText))) {
      return "human-decision";
    }

    const explicitApproval = rules.find(
      (rule) => rule.tier === "approval-gated" && contextText.includes(rule.pattern.replace(/\*/g, ""))
    );
    if (explicitApproval || APPROVAL_GATED_PATTERNS.some((pattern) => pattern.test(contextText))) {
      return "approval-gated";
    }

    const explicitAuto = rules.find(
      (rule) => rule.tier === "auto" && contextText.includes(rule.pattern.replace(/\*/g, ""))
    );
    if (explicitAuto) {
      return "auto";
    }

    if (request.type === "user-input") {
      return "human-decision";
    }

    const requestMethod =
      typeof request.context.requestMethod === "string" ? request.context.requestMethod : undefined;

    if (requestMethod === "item/fileChange/requestApproval") {
      if (this.isProtectedConfigChangeRequest(request)) {
        return "approval-gated";
      }
      return "auto";
    }

    if (requestMethod === "item/permissions/requestApproval") {
      if (request.type === "file-change") {
        return this.isWorkstreamScopedFilesystemPermission(workstream, request)
          ? "auto"
          : "approval-gated";
      }

      if (request.type === "network") {
        return this.isSafeLocalhostNetworkRequest(request) ? "auto" : "approval-gated";
      }
    }

    if (request.type === "command" && this.isConfiguredReadOnlyRemoteCommand(project, request)) {
      return "auto";
    }

    if (request.type === "command" && this.isRoutineCommand(request)) {
      return "auto";
    }

    if (request.type === "command" && this.isWorkstreamScopedCommand(workstream, request)) {
      return "auto";
    }

    if (request.type === "file-change") {
      if (this.isProtectedConfigChangeRequest(request)) {
        return "approval-gated";
      }
      return "auto";
    }

    return "approval-gated";
  }

  private buildApprovalContextText(request: ApprovalRequest): string {
    return [request.description, ...collectContextStrings(request.context)].join("\n");
  }

  private isProtectedConfigChangeRequest(request: ApprovalRequest): boolean {
    return collectContextStrings(request.context)
      .some((entry) => PROTECTED_CONFIG_PATH_PATTERNS.some((pattern) => pattern.test(entry)));
  }

  private isRoutineCommand(request: ApprovalRequest): boolean {
    const contextText = this.buildApprovalContextText(request);
    return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(contextText));
  }

  private isConfiguredReadOnlyRemoteCommand(project: ProjectConfig, request: ApprovalRequest): boolean {
    const remoteHosts = project.remoteHosts?.filter((candidate) => candidate.autoApproveReadOnlySsh) ?? [];
    if (remoteHosts.length === 0) {
      return false;
    }

    const commandText = commandTextFromRequest(request);
    if (!/\bssh(?:\.exe)?\b/i.test(commandText) || /\bscp\b/i.test(commandText)) {
      return false;
    }

    for (const remoteHost of remoteHosts) {
      if (!this.commandTargetsRemoteHost(commandText, remoteHost)) {
        continue;
      }

      const remoteCommand = this.extractRemoteCommand(commandText, remoteHost);
      if (!remoteCommand) {
        return false;
      }

      if (/[;&|><`]/.test(remoteCommand) || remoteCommand.includes("$(")) {
        return false;
      }

      if (UNSAFE_REMOTE_COMMAND_PATTERNS.some((pattern) => pattern.test(remoteCommand))) {
        return false;
      }

      if (SAFE_REMOTE_INSPECTION_PATTERNS.some((pattern) => pattern.test(remoteCommand))) {
        return true;
      }
    }

    return false;
  }

  private commandTargetsRemoteHost(commandText: string, remoteHost: RemoteHostConfig): boolean {
    return commandText.includes(`${remoteHost.user}@${remoteHost.host}`);
  }

  private extractRemoteCommand(commandText: string, remoteHost: RemoteHostConfig): string | null {
    const hostSpecifier = `${remoteHost.user}@${remoteHost.host}`;
    const hostIndex = commandText.indexOf(hostSpecifier);
    if (hostIndex < 0) {
      return null;
    }

    let trailing = commandText.slice(hostIndex + hostSpecifier.length).trim();
    if (!trailing) {
      return null;
    }

    if (trailing.startsWith("--")) {
      trailing = trailing.slice(2).trim();
    }

    const remoteCommand = stripOuterQuotes(trailing);
    return remoteCommand.length > 0 ? remoteCommand : null;
  }

  private isWorkstreamScopedCommand(workstream: WorkstreamRow, request: ApprovalRequest): boolean {
    const contextText = this.buildApprovalContextText(request);
    if (
      HUMAN_DECISION_PATTERNS.some((pattern) => pattern.test(contextText)) ||
      APPROVAL_GATED_PATTERNS.some((pattern) => pattern.test(contextText))
    ) {
      return false;
    }

    const rawCwd = request.context.cwd;
    const commandCwd = typeof rawCwd === "string" && rawCwd.length > 0 ? rawCwd : null;
    const allowedRoots = [workstream.cwd, this.getProject(workstream.project_id).repoPath].filter(
      (value): value is string => Boolean(value)
    );

    if (!commandCwd || !allowedRoots.some((allowedRoot) => isPathWithinRoot(commandCwd, allowedRoot))) {
      return false;
    }

    const commandText = commandTextFromRequest(request).toLowerCase();
    if (!commandText) {
      return false;
    }

    return !/\b(curl|wget|invoke-webrequest|scp|ssh)\b/i.test(commandText);
  }

  private isWorkstreamScopedFilesystemPermission(workstream: WorkstreamRow, request: ApprovalRequest): boolean {
    const rawPermissions = request.context.permissions;
    if (!rawPermissions || typeof rawPermissions !== "object" || Array.isArray(rawPermissions)) {
      return false;
    }

    const permissions = rawPermissions as Record<string, unknown>;
    const rawFileSystem = permissions.fileSystem;
    if (!rawFileSystem || typeof rawFileSystem !== "object" || Array.isArray(rawFileSystem)) {
      return false;
    }

    const fileSystem = rawFileSystem as Record<string, unknown>;
    const requestedPaths = [
      ...collectContextStrings(fileSystem.read),
      ...collectContextStrings(fileSystem.write),
    ].filter((value) => value.length > 0);

    if (requestedPaths.length === 0) {
      return false;
    }

    const allowedRoots = [workstream.cwd, this.getProject(workstream.project_id).repoPath].filter(
      (value): value is string => Boolean(value)
    );

    return requestedPaths.every((candidatePath) =>
      allowedRoots.some((allowedRoot) => isPathWithinRoot(candidatePath, allowedRoot))
    );
  }

  private isSafeLocalhostNetworkRequest(request: ApprovalRequest): boolean {
    const contextText = this.buildApprovalContextText(request).toLowerCase();
    return (
      contextText.includes("127.0.0.1") ||
      contextText.includes("localhost") ||
      contextText.includes("::1")
    );
  }

  private extractBackendApprovalId(approval: import("../state/index.js").ApprovalRow): string {
    if (!approval.context_json) {
      return approval.id;
    }

    try {
      const context = JSON.parse(approval.context_json) as Record<string, unknown>;
      const backendApprovalId = context.backendApprovalId;
      return typeof backendApprovalId === "string" && backendApprovalId.length > 0
        ? backendApprovalId
        : approval.id;
    } catch {
      return approval.id;
    }
  }

  private async recoverActiveWorkstreams() {
    const active = workstreams.listActive();
    if (active.length > 0) {
      log.info({ count: active.length }, "Recovering active workstreams");
      for (const ws of active) {
        if (ws.codex_thread_id) {
          const adapter = this.getAdapter(ws.project_id);
          const thread = await adapter.resumeThread(ws.codex_thread_id);
          if (!thread) {
            log.warn({ workstreamId: ws.id, threadId: ws.codex_thread_id }, "Could not resume thread");
            this.reconcileRecoveredWorkstream(ws, null);
            continue;
          }

          this.reconcileRecoveredWorkstream(ws, thread);
        }
      }
    }
  }

  private async prepareWorkstreamForDispatch(workstream: WorkstreamRow): Promise<WorkstreamRow> {
    const dispatchWorkstream = await this.ensureDispatchThread(workstream);
    const adapter = this.getAdapter(dispatchWorkstream.project_id);
    const thread =
      dispatchWorkstream.codex_thread_id
        ? await adapter.resumeThread(dispatchWorkstream.codex_thread_id)
        : null;

    if (thread && (thread.status === "active" || thread.status === "waiting_approval")) {
      throw new Error(
        "This workstream already has an active Codex turn. Wait for it to finish or run /workstream cancel before dispatching again."
      );
    }

    this.reconcileRecoveredWorkstream(dispatchWorkstream, thread);
    return workstreams.getById(dispatchWorkstream.id) ?? dispatchWorkstream;
  }

  private async ensureDispatchThread(workstream: WorkstreamRow): Promise<WorkstreamRow> {
    const adapter = this.getAdapter(workstream.project_id);
    const cwd = workstream.cwd ?? this.getProject(workstream.project_id).repoPath;

    if (workstream.codex_thread_id) {
      const resumed = await adapter.resumeThread(workstream.codex_thread_id);
      if (resumed) {
        return workstream;
      }

      log.warn(
        { workstreamId: workstream.id, missingThreadId: workstream.codex_thread_id },
        "Stored Codex thread is unavailable; creating a replacement thread"
      );
    }

    const replacementThread = await adapter.createThread(cwd);
    const updated =
      workstreams.update(workstream.id, {
        codex_thread_id: replacementThread.id,
        cwd,
      }) ?? {
        ...workstream,
        codex_thread_id: replacementThread.id,
        cwd,
      };

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.thread.rebound",
      payload: {
        previousThreadId: workstream.codex_thread_id,
        newThreadId: replacementThread.id,
        reason: workstream.codex_thread_id ? "thread-missing" : "thread-unbound",
      },
      source: "orchestrator",
    });

    return updated;
  }

  private syncConfiguredProjects() {
    for (const project of this.config.projects) {
      projects.upsert({
        id: project.id,
        name: project.name,
        repo_path: project.repoPath,
        config_json: JSON.stringify(project),
      });
    }
  }

  private findWorkstreamByThread(threadId: string) {
    // This is a linear scan — fine for small numbers of workstreams
    const active = workstreams.listActive();
    return active.find(ws => ws.codex_thread_id === threadId);
  }

  private reconcileRecoveredWorkstream(
    workstream: WorkstreamRow,
    thread: ExecutionThread | null
  ): void {
    const pendingApprovals = approvals.listPending(workstream.id);
    if (pendingApprovals.length === 0 && (workstream.waiting_on_approval || workstream.pending_decision)) {
      workstreams.update(workstream.id, {
        waiting_on_approval: 0,
        pending_decision: this.planningPendingDecisionForWorkstream(workstreams.getById(workstream.id)),
      });
    }

    if (thread && (thread.status === "active" || thread.status === "waiting_approval")) {
      return;
    }

    const reason = thread
      ? `Maverick recovered an idle Codex thread and marked this stale local turn as cancelled.`
      : "Maverick could not resume the prior Codex thread and marked this stale local turn as cancelled.";
    const cancelledTurns = this.markRunningTurnsCancelled(workstream.id, reason);

    if (cancelledTurns > 0) {
      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "turn.reconciled",
        payload: {
          cancelledTurns,
          threadStatus: thread?.status ?? "missing",
        },
        source: "orchestrator",
      });

      log.warn(
        { workstreamId: workstream.id, cancelledTurns, threadStatus: thread?.status ?? "missing" },
        "Reconciled stale running turns"
      );
    }
  }

  private markRunningTurnsCancelled(workstreamId: string, summary: string): number {
    const runningTurns = turns.listRunningByWorkstream(workstreamId);
    if (runningTurns.length === 0) {
      return 0;
    }

    const completedAt = new Date().toISOString();
    for (const turn of runningTurns) {
      turns.update(turn.id, {
        status: "cancelled",
        result_summary: summary,
        last_progress_at: completedAt,
        completed_at: completedAt,
      });
    }

    this.activeTurnByWorkstream.delete(workstreamId);
    return runningTurns.length;
  }

  private getProject(projectId: string): ProjectConfig {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  private getAdapter(projectId: string): ExecutionBackendAdapter {
    const adapter = this.adapters.get(projectId);
    if (!adapter) throw new Error(`No adapter for project: ${projectId}`);
    return adapter;
  }

  private getStateMachine(projectId: string): WorkstreamStateMachine {
    const sm = this.stateMachines.get(projectId);
    if (!sm) throw new Error(`No state machine for project: ${projectId}`);
    return sm;
  }

  private prepareTurnInstruction(
    workstream: WorkstreamRow,
    userInstruction: string
  ): { instruction: string; epicContextInjected: boolean } {
    const epicContext = this.getEpicCharterContext(workstream);
    if (!epicContext) {
      return {
        instruction: userInstruction,
        epicContextInjected: false,
      };
    }

    return {
      instruction: `${epicContext}\n\nUser request:\n${userInstruction}`,
      epicContextInjected: true,
    };
  }

  private getEpicCharterContext(workstream: WorkstreamRow): string | null {
    if (!workstream.epic_id) {
      return null;
    }

    const project = this.getProject(workstream.project_id);
    const epic = project.epicBranches.find((candidate) => candidate.id === workstream.epic_id);
    if (!epic) {
      log.warn(
        { projectId: project.id, workstreamId: workstream.id, epicId: workstream.epic_id },
        "Workstream references an epic that no longer exists in config"
      );
      return null;
    }

    return buildEpicCharterContext(project, epic) ?? null;
  }
}
