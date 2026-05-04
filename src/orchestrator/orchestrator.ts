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
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runAgent } from "../agents/agent-runner.js";
import { renderEpicContextAnalysis } from "../agents/epic-context-support.js";
import { renderIntakeMarkdown } from "../agents/intake-agent.js";
import {
  buildIncidentContinuationInstruction,
  coerceIncidentTriageResult,
} from "../agents/incident-triage-support.js";
import {
  buildPlanningContextRecord,
  mergePlanningAnswers,
  parsePlanningContextRecord,
  parsePlanningResult,
  renderPlanningSummary,
  serializePlanningAnswers,
  structureRawPlanningOutput,
} from "../agents/planning-support.js";
import { coerceReviewAgentResult } from "../agents/review-support.js";
import {
  buildVerificationContextRecord,
  coerceVerificationResult,
  parseVerificationContextRecord,
  renderVerificationSummary,
} from "../agents/verification-support.js";
import { createLogger } from "../logger.js";
import { renderMarkdownDocument } from "../markdown/presentation.js";
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
import {
  activeWorkstreamOperations,
  artifacts,
  getStateBackendMode,
  projects,
  workstreams,
  turns,
  approvals,
  discordThreadBindings,
  events as eventLog,
  workstreamRuntimeBindings,
} from "../state/index.js";
import type { ArtifactRow, DiscordThreadBindingRow, TurnRow, WorkstreamRow } from "../state/index.js";
import { createAdapter, type ExecutionBackendAdapter } from "../codex/index.js";
import type { ApprovalRequest, ExecutionThread, ReviewResult } from "../codex/types.js";
import type { EscalationTier, OrchestratorConfig, ProjectConfig, RemoteHostConfig } from "../config/schema.js";
import { normalizeEpicFirstConfig } from "../config/epic-first.js";
import {
  ensureProjectBootstrap,
  inspectProjectBootstrap,
  inspectWorktreeBootstrap,
  type BootstrapStatus,
} from "../projects/bootstrap.js";
import { buildEpicCharterContext, requireEpicById, workstreamLaneForEpic } from "../projects/epics.js";
import { provisionWorktree, recoverWorktreeForBranch } from "../git/worktree.js";
import {
  finishWorkstreamBranch,
  cleanupFinishedWorkstreamBranch,
  promoteLaneBranch,
  verifyLanePromotion,
  type GitCleanupResult,
  type GitLifecycleResult,
} from "../git/lifecycle.js";
import { getRuntimeInstanceId } from "../runtime/identity.js";
import type {
  AgentResult,
  PlanningAnswer,
  PlanningContextBundle,
  PlanningContextRecord,
  PlanningResult,
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
type WorkstreamFinishTrigger = "manual" | "auto";

export interface LaneTarget {
  projectId: string;
  laneId: string;
  durableBranch: string;
  productionBranch: string;
  source: "lane" | "epic";
}

export interface WorkstreamFinishResult {
  workstreamId: string;
  workstreamName: string;
  projectId: string;
  durableBranch: string;
  workstreamBranch: string;
  archived: boolean;
  git: GitLifecycleResult;
}

export interface WorkstreamCleanupResult {
  workstreamId: string;
  workstreamName: string;
  projectId: string;
  durableBranch: string;
  workstreamBranch: string;
  git: GitCleanupResult;
}

export interface LaneLifecycleResult {
  lane: LaneTarget;
  git: GitLifecycleResult;
}

export interface DiscordThreadBindingRepair {
  threadId: string;
  projectId: string;
  changed: boolean;
  reason: string | null;
  before: {
    epicId: string | null;
    lane: string | null;
    baseBranch: string | null;
  };
  after: {
    epicId: string | null;
    lane: string | null;
    baseBranch: string | null;
  };
}

export type WorkstreamRepairAction =
  | "force-unblock"
  | "reset-to-planning"
  | "rebind-thread";

export interface WorkstreamRepairResult {
  action: WorkstreamRepairAction;
  workstreamId: string;
  workstreamName: string;
  stateBefore: string;
  stateAfter: string;
  cancelledTurns: number;
  expiredApprovals: number;
  clearedActiveOperations: number;
  message: string;
}

export interface WorkstreamThreadRebindInput {
  channelId: string;
  threadId?: string | null;
  parentChannelId?: string | null;
  reboundBy?: string;
}

type PlanningRoutingAgent =
  | "planning"
  | "epic-context";

const PLANNING_AGENT_ROUTE_KEYS = {
  planning: "planning",
  "epic-context": "epicContext",
} as const satisfies Record<
  PlanningRoutingAgent,
  keyof NonNullable<NonNullable<ProjectConfig["claudePlanning"]>["routing"]>["agents"]
>;

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

function splitMetadataList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;|\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type ActiveOperationKind = ActiveOperationSnapshot["kind"];

type ActiveOperationState = {
  kind: ActiveOperationKind;
  startedAt: string;
  lastProgressAt: string;
};

export class Orchestrator {
  private config: OrchestratorConfig;
  private readonly instanceId: string;
  private adapters: Map<string, ExecutionBackendAdapter> = new Map();
  private stateMachines: Map<string, WorkstreamStateMachine> = new Map();
  private activeTurnByWorkstream = new Map<string, string>();
  private activeOperationByWorkstream = new Map<string, ActiveOperationState>();
  private projectBootstrap = new Map<string, BootstrapStatus>();
  private utilityClaudeAdapter: ExecutionBackendAdapter | null = null;
  private initialized = false;

  // Auto-advance locking and tracking
  private autoAdvanceLocks = new Map<string, Promise<void>>();
  private loopDetection = new Map<string, { transition: string; count: number; timestamp: number }>();
  private verificationRetryCount = new Map<string, number>();

  constructor(config: OrchestratorConfig) {
    this.config = normalizeEpicFirstConfig(config);
    this.instanceId = getRuntimeInstanceId();
  }

  // --- Lifecycle ---

  async initialize(): Promise<void> {
    if (this.initialized) return;

    log.info("Initializing orchestrator");

    this.syncConfiguredProjects();
    this.reconcileStoredWorkspaceMetadata();
    const bindingRepair = this.repairDiscordThreadBindings();
    if (bindingRepair.changed.length > 0 || bindingRepair.unresolved.length > 0) {
      log.info(
        {
          changedBindings: bindingRepair.changed.length,
          unresolvedBindings: bindingRepair.unresolved.length,
        },
        "Discord thread bindings reconciled against configured durable lanes"
      );
    }

    // Create execution adapters per project (or use default)
    for (const project of this.config.projects) {
      const bootstrapStatus = inspectProjectBootstrap(project);
      this.projectBootstrap.set(project.id, bootstrapStatus);
      log.info(
        {
          projectId: project.id,
          createdBootstrapFiles: bootstrapStatus.createdFiles.length,
          missingBootstrapFiles: bootstrapStatus.missingFiles.length,
        },
        "Project bootstrap inspected"
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
    log.info({ projects: this.config.projects.length }, "Orchestrator initialized");
  }

  async shutdown(): Promise<void> {
    log.info("Shutting down orchestrator");
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
    discordThreadId?: string;
    discordParentChannelId?: string;
    baseBranch?: string;
    lane?: string;
    epicId?: string;
  }) {
    const project = this.getProject(params.projectId);
    const adapter = this.getAdapter(params.projectId);
    const sm = this.getStateMachine(params.projectId);
    let resolvedBaseBranch = params.baseBranch;
    let resolvedLane = params.lane;
    let resolvedEpicId = params.epicId;

    if (!resolvedEpicId && params.lane) {
      const epic = project.epicBranches.find((candidate) =>
        candidate.id === params.lane ||
        candidate.branch === params.lane ||
        workstreamLaneForEpic(candidate) === params.lane
      );
      resolvedEpicId = epic?.id;
    }

    if (!resolvedEpicId && params.baseBranch) {
      const epic = project.epicBranches.find((candidate) => candidate.branch === params.baseBranch);
      resolvedEpicId = epic?.id;
    }

    if (resolvedEpicId) {
      const epic = requireEpicById(project, resolvedEpicId);
      const epicLane = workstreamLaneForEpic(epic);
      if (params.baseBranch && params.baseBranch !== epic.branch) {
        throw new Error(
          `Workstream requested epic "${resolvedEpicId}" but base branch "${params.baseBranch}" does not match "${epic.branch}".`
        );
      }
      if (params.lane && params.lane !== epicLane) {
        throw new Error(
          `Workstream requested epic "${resolvedEpicId}" but lane "${params.lane}" does not match "${epicLane}".`
        );
      }

      resolvedBaseBranch ??= epic.branch;
      resolvedLane ??= epicLane;
    }

    if (project.workspaceKind === "git" && !resolvedEpicId) {
      const available = project.epicBranches.map((epic) => epic.id).join(", ") || "none configured";
      throw new Error(
        `Project "${project.id}" requires a configured epic before Maverick can create a worktree. Available epics: ${available}. Start from a Discord thread whose slug matches an epic or pass the epic option explicitly.`
      );
    }

    const workstreamId = randomUUID();
    const workspace = await provisionWorktree({
      repoPath: project.repoPath,
      projectId: params.projectId,
      workstreamId,
      name: params.name,
      workspaceKind: project.workspaceKind,
      lane: resolvedLane,
      baseRef: resolvedBaseBranch,
    });

    if (
      project.workspaceKind === "git" &&
      workspace.mode !== "worktree" &&
      !this.shouldAllowLegacyRootWorkspace(project)
    ) {
      throw new Error(
        `Project "${project.id}" is git-backed and must dispatch from a worktree. Maverick resolved workspace mode "${workspace.mode}" instead.`
      );
    }

    if (workspace.mode === "worktree") {
      const bootstrapStatus = inspectWorktreeBootstrap(project, workspace.cwd);
      if (bootstrapStatus.missingFiles.length > 0) {
        log.warn(
          {
            projectId: project.id,
            workstreamId,
            missingBootstrapFiles: bootstrapStatus.missingFiles.length,
          },
          "Worktree bootstrap is missing doctrine files; inspect with /maverick audit"
        );
      }
    }

    // Create execution thread
    const thread = await adapter.createThread(workspace.cwd);

    // Persist workstream
    const ws = workstreams.create({
      id: workstreamId,
      project_id: params.projectId,
      epic_id: resolvedEpicId,
      name: params.name,
      description: params.description,
      cwd: workspace.cwd,
      branch: workspace.branch ?? undefined,
      base_branch: resolvedBaseBranch,
      workspace_mode: workspace.mode,
      execution_backend: adapter.name,
      discord_channel_id: params.discordChannelId,
      discord_thread_id: params.discordThreadId,
      discord_parent_channel_id: params.discordParentChannelId,
    });

    // Bind thread
    workstreams.update(ws.id, {
      codex_thread_id: thread.id,
      state: sm.initialState,
    });
    workstreamRuntimeBindings.upsert({
      workstream_id: ws.id,
      instance_id: this.instanceId,
      cwd: workspace.cwd,
      codex_thread_id: thread.id,
      runtime_status: "idle",
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

    const startedAt = new Date().toISOString();
    this.beginActiveOperation(workstreamId, "implementation", startedAt);

    let turn: TurnRow;
    try {
      // Create turn record only after the shared DB guard is held.
      turn = turns.create({
        workstream_id: workstreamId,
        instruction,
      });
      this.activeTurnByWorkstream.set(workstreamId, turn.id);

      turns.update(turn.id, {
        status: "running",
        started_at: startedAt,
        last_progress_at: startedAt,
      });
    } catch (error) {
      this.activeTurnByWorkstream.delete(workstreamId);
      this.completeActiveOperation(workstreamId);
      throw error;
    }

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
        cwd: this.resolveExecutionWorkspace(dispatchWorkstream),
        maxBudgetUsd: 0.75,
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
      if (result.status === "completed") {
        this.pushDisposableBranchIfClean(dispatchWorkstream);
      }

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
    const threadId = ws ? this.resolveRuntimeThreadId(ws) : null;
    if (!ws || !threadId) throw new Error(`Workstream not found or no runtime thread on ${this.instanceId}: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    await adapter.steerTurn({ threadId, instruction });
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
    const threadId = ws ? this.resolveRuntimeThreadId(ws) : null;
    if (!ws || !threadId) throw new Error(`Workstream not found or no runtime thread on ${this.instanceId}: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    await adapter.interruptTurn(threadId);
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
    const threadId = this.resolveRuntimeThreadId(ws);
    if (activeTurnId && threadId) {
      const adapter = this.getAdapter(ws.project_id);
      await adapter.interruptTurn(threadId);
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
    const archivedWorkstream = workstreams.getById(workstreamId) ?? { ...ws, state: "done" };
    const projectMemoryPath = this.appendProjectMemoryEntry(archivedWorkstream, archivedBy);

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
        projectMemoryPath,
      },
      source: "orchestrator",
    });

    log.info(
      { workstreamId, projectId: ws.project_id, archivedBy, interruptedActiveTurn: Boolean(activeTurnId) },
      "Workstream archived"
    );

    return workstreams.getById(workstreamId)!;
  }

  async finishWorkstream(
    workstreamId: string,
    options?: {
      trigger?: WorkstreamFinishTrigger;
      finishedBy?: string;
    },
  ): Promise<WorkstreamFinishResult> {
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    const project = this.getProject(ws.project_id);
    if (!this.isGitBackedProject(project)) {
      throw new Error(`Project "${project.id}" is not git-backed; workstream finish is only available for git projects.`);
    }

    if (ws.workspace_mode !== "worktree") {
      throw new Error(
        `Workstream "${ws.name}" is in workspace mode "${ws.workspace_mode}". Finish requires a disposable git worktree.`
      );
    }

    if (!ws.cwd || !ws.branch || !ws.base_branch) {
      throw new Error(`Workstream "${ws.name}" is missing cwd, branch, or durable base branch metadata.`);
    }

    const verificationContext = parseVerificationContextRecord(ws.verification_context_json);
    if (verificationContext?.result.status !== "pass") {
      throw new Error(`Workstream "${ws.name}" cannot finish until verification has passed.`);
    }

    const target = this.resolveLaneTargetForWorkstream(ws);
    const git = await finishWorkstreamBranch({
      cwd: ws.cwd,
      workstreamBranch: ws.branch,
      durableBranch: target.durableBranch,
    });

    eventLog.emit({
      workstream_id: ws.id,
      project_id: ws.project_id,
      event_type: git.status === "merged" ? "workstream.finishMerged" : "workstream.finishBlocked",
      payload: {
        trigger: options?.trigger ?? "manual",
        finishedBy: options?.finishedBy ?? "system",
        lane: target,
        git,
      },
      source: "orchestrator",
    });

    if (git.status !== "merged") {
      throw new Error(git.reason ?? `Workstream "${ws.name}" could not be merged into "${target.durableBranch}".`);
    }

    const archived = await this.archive(ws.id, options?.finishedBy ?? "finish");
    eventBus.emit("workstream.finished", {
      workstreamId: ws.id,
      projectId: ws.project_id,
      durableBranch: target.durableBranch,
      workstreamBranch: ws.branch,
      trigger: options?.trigger ?? "manual",
    });

    return {
      workstreamId: ws.id,
      workstreamName: ws.name,
      projectId: ws.project_id,
      durableBranch: target.durableBranch,
      workstreamBranch: ws.branch,
      archived: archived.state === "done",
      git,
    };
  }

  async cleanupFinishedWorkstream(workstreamId: string): Promise<WorkstreamCleanupResult> {
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    if (ws.state !== "done") {
      throw new Error(`Workstream "${ws.name}" is not archived/done yet.`);
    }

    const project = this.getProject(ws.project_id);
    if (!this.isGitBackedProject(project)) {
      throw new Error(`Project "${project.id}" is not git-backed; cleanup is only available for git projects.`);
    }

    if (ws.workspace_mode !== "worktree") {
      throw new Error(`Workstream "${ws.name}" is in workspace mode "${ws.workspace_mode}", not a disposable worktree.`);
    }

    if (!ws.cwd || !ws.branch || !ws.base_branch) {
      throw new Error(`Workstream "${ws.name}" is missing cwd, branch, or durable base branch metadata.`);
    }

    const target = this.resolveLaneTargetForWorkstream(ws);
    const git = await cleanupFinishedWorkstreamBranch({
      repoPath: project.repoPath,
      worktreePath: ws.cwd,
      workstreamBranch: ws.branch,
      durableBranch: target.durableBranch,
    });

    eventLog.emit({
      workstream_id: ws.id,
      project_id: ws.project_id,
      event_type: "workstream.cleanupCompleted",
      payload: {
        durableBranch: target.durableBranch,
        workstreamBranch: ws.branch,
        git,
      },
      source: "orchestrator",
    });

    return {
      workstreamId: ws.id,
      workstreamName: ws.name,
      projectId: ws.project_id,
      durableBranch: target.durableBranch,
      workstreamBranch: ws.branch,
      git,
    };
  }

  async reapFinishedWorkstreams(): Promise<{
    cleaned: WorkstreamCleanupResult[];
    skipped: Array<{ workstreamId: string; reason: string }>;
  }> {
    const cleaned: WorkstreamCleanupResult[] = [];
    const skipped: Array<{ workstreamId: string; reason: string }> = [];

    for (const project of this.config.projects) {
      for (const workstream of workstreams.listByProject(project.id)) {
        if (
          workstream.state !== "done" ||
          workstream.workspace_mode !== "worktree" ||
          !workstream.cwd ||
          !workstream.branch ||
          !workstream.base_branch
        ) {
          continue;
        }

        try {
          const result = await this.cleanupFinishedWorkstream(workstream.id);
          if (result.git.status === "cleaned") {
            cleaned.push(result);
          } else {
            skipped.push({
              workstreamId: workstream.id,
              reason: result.git.reason ?? "Cleanup skipped.",
            });
          }
        } catch (error) {
          skipped.push({
            workstreamId: workstream.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (cleaned.length > 0 || skipped.length > 0) {
      eventLog.emit({
        event_type: "workstream.reaperCompleted",
        payload: {
          cleaned: cleaned.length,
          skipped: skipped.length,
          skippedWorkstreams: skipped.slice(0, 20),
        },
        source: "orchestrator",
      });
    }

    return { cleaned, skipped };
  }

  async verifyLane(projectId: string, laneId?: string | null): Promise<LaneLifecycleResult> {
    const lane = this.resolveLaneTarget(projectId, laneId);
    const project = this.getProject(projectId);
    const git = await verifyLanePromotion({
      repoPath: project.repoPath,
      laneBranch: lane.durableBranch,
      productionBranch: lane.productionBranch,
    });

    eventLog.emit({
      project_id: projectId,
      event_type: "lane.verifyCompleted",
      payload: { lane, git },
      source: "orchestrator",
    });

    return { lane, git };
  }

  async promoteLane(
    projectId: string,
    laneId?: string | null,
    promotedBy = "system",
  ): Promise<LaneLifecycleResult> {
    const project = this.getProject(projectId);
    if (!project.promoteRequiresExplicitCommand) {
      log.warn({ projectId }, "Project allows non-explicit promotion, but promoteLane was invoked explicitly");
    }

    const lane = this.resolveLaneTarget(projectId, laneId);
    const git = await promoteLaneBranch({
      repoPath: project.repoPath,
      laneBranch: lane.durableBranch,
      productionBranch: lane.productionBranch,
    });

    eventLog.emit({
      project_id: projectId,
      event_type: git.status === "merged" ? "lane.productionPromoted" : "lane.promoteBlocked",
      payload: { lane, git, promotedBy },
      source: "orchestrator",
    });

    return { lane, git };
  }

  async transitionState(workstreamId: string, trigger: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    const updated = this.forceTransitionState(ws, trigger);
    const newState = updated.state;
    log.info({ workstreamId, from: ws.state, to: newState, trigger }, "State transitioned");
    return newState;
  }

  /**
   * Attempt to automatically advance a workstream to the next state based on its current state
   * and configured auto-advance transitions. Uses per-workstream locking to prevent re-entrancy,
   * loop detection to prevent rapid repeated transitions, and retry caps for verification failures.
   *
   * @param workstreamId - The workstream to attempt auto-advancing
   * @param hint - Optional hint about what transition to try (e.g., "plan-approved")
   */
  async tryAutoAdvance(workstreamId: string, hint?: string): Promise<boolean> {
    if (this.activeOperationByWorkstream.has(workstreamId)) {
      log.debug({ workstreamId }, "Auto-advance skipped while an operation is active");
      return false;
    }

    // Acquire per-workstream lock to prevent concurrent auto-advances
    const existingLock = this.autoAdvanceLocks.get(workstreamId);
    if (existingLock) {
      log.debug({ workstreamId }, "Auto-advance already in progress, skipping");
      return false;
    }

    let advanced = false;
    const lockPromise = (async () => {
      try {
        const ws = workstreams.getById(workstreamId);
        if (!ws) {
          log.warn({ workstreamId }, "Workstream not found for auto-advance");
          return;
        }

        const sm = this.getStateMachine(ws.project_id);
        let transitionToAttempt: string | null = hint ?? null;

        // If no hint, check which auto-advance transitions are available from current state
        if (!transitionToAttempt) {
          const availableTransitions = sm.getAutoAdvanceTransitions(ws.state);
          if (availableTransitions.length === 0) {
            log.debug({ workstreamId, state: ws.state }, "No auto-advance transitions available");
            return;
          }
          // Try the first available auto-advance transition
          transitionToAttempt = availableTransitions[0].trigger;
        }

        const ws_fresh = workstreams.getById(workstreamId);
        if (!ws_fresh) return;

        const transition = sm.canTransition(ws_fresh.state, transitionToAttempt);
        if (!transition.allowed) {
          log.debug(
            { workstreamId, state: ws_fresh.state, trigger: transitionToAttempt, reason: transition.reason },
            "Cannot auto-advance: transition not allowed",
          );
          return;
        }

        if (!transition.autoAdvance) {
          log.debug(
            { workstreamId, state: ws_fresh.state, trigger: transitionToAttempt },
            "Cannot auto-advance: transition is not marked autoAdvance",
          );
          return;
        }

        if (transitionToAttempt === "plan-approved") {
          const planningContext = parsePlanningContextRecord(ws_fresh.planning_context_json);
          if (
            !planningContext ||
            planningContext.pendingQuestions.length > 0 ||
            !(planningContext.finalExecutionPrompt ?? "").trim()
          ) {
            log.debug(
              {
                workstreamId,
                pendingQuestionCount: planningContext?.pendingQuestions.length ?? null,
                finalPromptReady: Boolean((planningContext?.finalExecutionPrompt ?? "").trim()),
              },
              "Cannot auto-advance planning: questions remain or no final execution prompt is ready",
            );
            return;
          }
        }

        // Check loop detection: abort if same transition fires 3+ times in 60 seconds
        const loopKey = `${workstreamId}:${transitionToAttempt}`;
        const loopRecord = this.loopDetection.get(loopKey);
        const now = Date.now();
        if (loopRecord && now - loopRecord.timestamp < 60000) {
          loopRecord.count++;
          if (loopRecord.count >= 3) {
            log.error(
              { workstreamId, transition: transitionToAttempt, count: loopRecord.count },
              "Loop detected: same transition fired 3+ times in 60 seconds",
            );
            this.loopDetection.delete(loopKey);
            return;
          }
        } else {
          this.loopDetection.set(loopKey, { transition: transitionToAttempt, count: 1, timestamp: now });
        }

        // Check retry caps for verification failures
        if (ws.state === "verification") {
          const retryCount = this.verificationRetryCount.get(workstreamId) ?? 0;
          if (retryCount >= 2) {
            log.warn(
              { workstreamId, retryCount },
              "Verification retry cap reached (max 2 retries); blocking auto-advance",
            );
            return;
          }
        }

        // Perform the transition
        const updated = this.tryTransitionState(ws_fresh, transitionToAttempt);
        advanced = updated.state !== ws_fresh.state;
        log.info(
          { workstreamId, from: ws_fresh.state, to: updated.state, trigger: transitionToAttempt },
          "Auto-advanced workstream",
        );

        // Track if this was a verification transition for retry counting
        if (transitionToAttempt === "verification-failed") {
          this.verificationRetryCount.set(workstreamId, (this.verificationRetryCount.get(workstreamId) ?? 0) + 1);
        } else if (transitionToAttempt === "verification-passed") {
          // Clear retry count on success
          this.verificationRetryCount.delete(workstreamId);
        }

        eventLog.emit({
          workstream_id: workstreamId,
          project_id: ws_fresh.project_id,
          event_type: "workstream.autoAdvanced",
          payload: { from: ws_fresh.state, to: updated.state, trigger: transitionToAttempt },
          source: "orchestrator",
        });
      } finally {
        this.autoAdvanceLocks.delete(workstreamId);
      }
    })();

    this.autoAdvanceLocks.set(workstreamId, lockPromise);
    await lockPromise;
    return advanced;
  }

  async bootstrapProjectRoadmap(projectId: string): Promise<{ filePath: string; snippet: string }> {
    const project = this.getProject(projectId);
    const filePath = this.projectRoadmapPath(project);
    if (existsSync(filePath)) {
      throw new Error(
        `PROJECT_ROADMAP.md already exists at ${filePath}. Delete or edit it manually before re-running bootstrap.`,
      );
    }

    const readme = this.readPlanningDoc(project, "README.md").content || "(no README.md found)";
    const packageJson = this.readPlanningDoc(project, "package.json").content || "(no package.json found)";
    const agents = this.readAgentsMd(project) || "(no AGENTS.md found)";
    const srcListing = this.readSrcLayout(project);
    const recentCommits = this.readGitOutput(
      ["log", "-10", "--pretty=format:%h %ad %s", "--date=short"],
      project.repoPath,
    );

    const adapter = await this.getUtilityClaudeAdapter();
    const cwd = project.repoPath;
    const thread = await adapter.createThread(cwd);

    const promptHeader = [
      "You are drafting the initial PROJECT_ROADMAP.md for a project. Use the provided repo signals (README, package.json, top-level src layout, AGENTS doctrine, recent commits) to draft a forward-looking roadmap with 3-7 milestones. Each milestone should have:",
      "- A clear name (verb + noun)",
      "- 2-4 sentences of intent",
      "- Concrete success criteria",
      "- Optional dependencies on other milestones",
      "",
      "This is a DRAFT for the operator to edit. Do not invent business goals you can't ground in the signals. If a section is genuinely unknowable from signals, mark it with TODO and ask the operator (in a final \"Questions for the operator\" section).",
      "",
      "Output as plain markdown.",
    ].join("\n");

    const promptBody = [
      "# Repo signals",
      "",
      "## README.md",
      "",
      readme,
      "",
      "## package.json",
      "",
      packageJson,
      "",
      "## AGENTS.md",
      "",
      agents,
      "",
      "## src/ layout (top 2 levels)",
      "",
      srcListing,
      "",
      "## Recent commits (last 10)",
      "",
      recentCommits,
    ].join("\n");

    const result = await adapter.startTurn({
      threadId: thread.id,
      instruction: `${promptHeader}\n\n${promptBody}`,
      cwd,
      maxTurns: 4,
      permissionMode: "plan",
      maxBudgetUsd: 0.75,
      noSessionPersistence: true,
      tools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Bash", "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch"],
    });

    if (result.status !== "completed") {
      throw new Error(result.output || "Roadmap bootstrap call failed.");
    }

    const draft = result.output.trim();
    if (!draft) {
      throw new Error("Roadmap bootstrap returned an empty draft.");
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, draft + (draft.endsWith("\n") ? "" : "\n"), "utf8");

    eventLog.emit({
      project_id: projectId,
      event_type: "project.roadmapBootstrapped",
      payload: { filePath },
      source: "orchestrator",
    });

    return { filePath, snippet: draft.slice(0, 1500) };
  }

  private readSrcLayout(project: ProjectConfig): string {
    const srcRoot = resolve(project.repoPath, "src");
    if (!existsSync(srcRoot)) {
      return "(no src/ directory found)";
    }
    try {
      const lines: string[] = [];
      for (const entry of readdirSync(srcRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          lines.push(`src/${entry.name}/`);
          const child = resolve(srcRoot, entry.name);
          try {
            for (const inner of readdirSync(child, { withFileTypes: true }).sort((a, b) =>
              a.name.localeCompare(b.name),
            )) {
              if (inner.name.startsWith(".")) continue;
              lines.push(`  src/${entry.name}/${inner.name}${inner.isDirectory() ? "/" : ""}`);
            }
          } catch {
            // ignore unreadable subdirectory
          }
        } else {
          lines.push(`src/${entry.name}`);
        }
      }
      return lines.join("\n") || "(empty src/)";
    } catch (error) {
      return `(failed to inspect src/: ${error instanceof Error ? error.message : String(error)})`;
    }
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

    const runtimeThreadId = this.resolveRuntimeThreadId(ws);
    if (reviewer === "primary" && !runtimeThreadId) {
      throw new Error(`Workstream not found or no runtime thread on ${this.instanceId}: ${workstreamId}`);
    }

    const effectiveTarget = target ?? "uncommitted";
    const latestTurn = turns.listByWorkstream(ws.id).slice(-1)[0] ?? null;
    this.beginActiveOperation(workstreamId, "review");
    try {
      const result =
        reviewer === "claude"
          ? await this.runClaudeReview(ws, effectiveTarget, latestTurn?.id ?? null, 0.75)
          : await this.getAdapter(ws.project_id).startReview({
              threadId: runtimeThreadId!,
              cwd: this.resolveExecutionWorkspace(ws),
              target: effectiveTarget,
              maxBudgetUsd: 0.75,
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

    const cwd = this.resolveExecutionWorkspace(workstream);
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
            "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
          },
        },
        {
          threadId: previousContext?.verificationThreadId ?? undefined,
          model: verificationConfig.model,
          maxTurns: 8,
          permissionMode: "auto",
          maxBudgetUsd: 0.75,
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
        const startedAutoFinish = this.maybeStartAutoFinishAfterVerification(updatedWorkstream, latestTurn?.id ?? null);
        if (!startedAutoFinish) {
          this.maybeStartAutoClaudeReviewAfterVerification(updatedWorkstream, latestTurn?.id ?? null);
        }
      }

      return {
        verificationContext,
        renderedVerification,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
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
    if (options.resumeExisting && storedContext?.status === "needs-final-prompt") {
      const structured = this.structureStoredPlanningContext(workstream.id, "resume");
      if (structured.finalExecutionPrompt) {
        return structured;
      }
    }

    const cwd = this.resolveExecutionWorkspace(workstream);
    const adapter = await this.getUtilityClaudeAdapter();
    const previousContext = options.resumeExisting ? storedContext : null;
    const effectiveInstruction = previousContext?.originalInstruction ?? instruction;
    const contextBundle = this.buildPlanningContextBundle(workstream, effectiveInstruction, previousContext);

    if (
      !options.resumeExisting &&
      trigger === "manual" &&
      storedContext &&
      storedContext.contextBundle?.contextFingerprint === contextBundle.contextFingerprint &&
      storedContext.pendingQuestions.length === 0 &&
      (storedContext.finalExecutionPrompt ?? "").trim().length > 0
    ) {
      log.info(
        { workstreamId, fingerprint: contextBundle.contextFingerprint },
        "Planning context unchanged; reusing stored plan instead of recalling Claude",
      );
      this.touchProgress("planning", workstream.id);
      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "planning.reused",
        payload: { fingerprint: contextBundle.contextFingerprint },
        source: "orchestrator",
      });
      return {
        renderedPlan: renderPlanningSummary(storedContext),
        planningContext: storedContext,
        finalExecutionPrompt: storedContext.finalExecutionPrompt,
        needsAnswers: false,
      };
    }

    const epicContextAnalysis = contextBundle.epicContext;
    let result: GeneratedPlanResult | null = null;
    let shouldAutoAdvance = false;
    this.beginActiveOperation(workstreamId, "planning");
    try {
      let checkpoint = this.checkpointPlanningContext({
        workstream,
        instruction: effectiveInstruction,
        stage: "planning request",
        contextBundle,
        previous: previousContext,
      });
      const agentResult = await runAgent(
        adapter,
        "planning",
        this.buildPlanningAgentContext(
          workstream,
          effectiveInstruction,
          previousContext,
          undefined,
          epicContextAnalysis,
          contextBundle,
        ),
        {
          threadId: previousContext?.planningThreadId ?? undefined,
          model: this.resolvePlanningAgentModel(project, "planning"),
          maxTurns: 6,
          permissionMode: "plan",
          onOutput: this.buildOperationOutputHandler("planning", workstream.id),
          ...this.planningAgentGuardrails("plan"),
          maxBudgetUsd: 0.75,
        },
      );

      if (agentResult.status !== "completed") {
        throw new Error(agentResult.output || "Claude plan generation failed.");
      }

      const planningResult = this.coercePlanningAgentResult(
        workstream,
        effectiveInstruction,
        agentResult,
        contextBundle,
      );
      const planningContext = buildPlanningContextRecord({
        originalInstruction: effectiveInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        contextBundle,
        planningThreadId: agentResult.threadId,
        previous: checkpoint,
      });

      const renderedPlan = this.persistPlanningContext(workstream, effectiveInstruction, planningContext, trigger);
      this.touchProgress("planning", workstream.id);
      this.persistOperatorReport(
        workstream,
        this.buildPlanOperatorReport(workstream, planningContext, trigger),
      );

      shouldAutoAdvance = planningContext.pendingQuestions.length === 0 && Boolean(planningContext.finalExecutionPrompt);
      result = {
        renderedPlan,
        planningContext,
        finalExecutionPrompt: planningContext.finalExecutionPrompt,
        needsAnswers: planningContext.pendingQuestions.length > 0,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
    }

    if (shouldAutoAdvance) {
      await this.tryAutoAdvance(workstreamId, "plan-approved");
    }

    if (!result) {
      throw new Error(`Planning did not produce a result for workstream ${workstreamId}.`);
    }
    return result;
  }

  getPlanningContext(workstreamId: string): PlanningContextRecord | null {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      return null;
    }

    return parsePlanningContextRecord(workstream.planning_context_json);
  }

  structureStoredPlanningContext(
    workstreamId: string,
    trigger: PlanningRunTrigger = "resume",
  ): GeneratedPlanResult {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const existingContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (!existingContext) {
      throw new Error(`Workstream ${workstreamId} has no stored planning context to structure.`);
    }

    const planningResult = this.structureRawPlanningOutputForWorkstream(
      workstream,
      existingContext.originalInstruction,
      existingContext.rawAgentOutput,
      existingContext.contextBundle,
    );
    if (!planningResult) {
      throw new Error(
        `Stored planning output for "${workstream.name}" could not be structured deterministically.`
      );
    }
    this.assertPlanningResultIsActionable(planningResult);

    const planningContext = buildPlanningContextRecord({
      originalInstruction: existingContext.originalInstruction,
      result: planningResult,
      rawAgentOutput: existingContext.rawAgentOutput,
      contextBundle: existingContext.contextBundle,
      intake: existingContext.intake,
      answers: existingContext.answers,
      planningThreadId: existingContext.planningThreadId,
      previous: existingContext,
    });

    const renderedPlan = this.persistPlanningContext(
      workstream,
      existingContext.originalInstruction,
      planningContext,
      trigger,
    );
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

    let result: GeneratedPlanResult | null = null;
    let shouldAutoAdvance = false;
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
      const contextBundle = this.buildPlanningContextBundle(
        workstream,
        existingContext.originalInstruction,
        existingContext,
      );
      const epicContextAnalysis = contextBundle.epicContext;
      const checkpoint = this.checkpointPlanningContext({
        workstream,
        instruction: existingContext.originalInstruction,
        stage: "answered planning resume",
        contextBundle,
        previous: existingContext,
        answers: mergedAnswers,
      });
      const agentResult = await runAgent(
        adapter,
        "planning",
        this.buildPlanningAgentContext(
          workstream,
          existingContext.originalInstruction,
          existingContext,
          mergedAnswers,
          epicContextAnalysis,
          contextBundle,
        ),
        {
          threadId: existingContext.planningThreadId ?? undefined,
          model: this.resolvePlanningAgentModel(project, "planning"),
          maxTurns: 6,
          permissionMode: "plan",
          onOutput: this.buildOperationOutputHandler("planning", workstream.id),
          ...this.planningAgentGuardrails("plan"),
          maxBudgetUsd: 0.75,
        },
      );

      if (agentResult.status !== "completed") {
        throw new Error(agentResult.output || "Claude planning resume failed.");
      }

      const planningResult = this.coercePlanningAgentResult(
        workstream,
        existingContext.originalInstruction,
        agentResult,
        contextBundle,
      );
      const planningContext = buildPlanningContextRecord({
        originalInstruction: existingContext.originalInstruction,
        result: planningResult,
        rawAgentOutput: agentResult.output,
        contextBundle,
        planningThreadId: agentResult.threadId,
        answers: mergedAnswers,
        previous: checkpoint,
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

      shouldAutoAdvance = planningContext.pendingQuestions.length === 0 && Boolean(planningContext.finalExecutionPrompt);
      result = {
        renderedPlan,
        planningContext,
        finalExecutionPrompt: planningContext.finalExecutionPrompt,
        needsAnswers: planningContext.pendingQuestions.length > 0,
      };
    } finally {
      this.completeActiveOperation(workstreamId);
    }

    if (shouldAutoAdvance) {
      await this.tryAutoAdvance(workstreamId, "plan-approved");
    }

    if (!result) {
      throw new Error(`Planning answers did not produce a result for workstream ${workstreamId}.`);
    }
    return result;
  }

  forceUnblockWorkstream(workstreamId: string, repairedBy = "system"): WorkstreamRepairResult {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const cancelledTurns = this.markRunningTurnsCancelled(
      workstream.id,
      `Force-unblocked by ${repairedBy}; stale running turn was cancelled locally.`,
    );
    const expiredApprovals = approvals.expirePendingByWorkstream(workstream.id, repairedBy);
    const clearedActiveOperations = activeWorkstreamOperations.clear(workstream.id);
    this.activeOperationByWorkstream.delete(workstream.id);

    workstreams.update(workstream.id, {
      waiting_on_approval: 0,
      pending_decision: this.planningPendingDecisionForWorkstream(workstream),
      current_goal: cancelledTurns > 0 ? null : workstream.current_goal,
    });
    const updated = workstreams.getById(workstream.id) ?? workstream;

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.repair.forceUnblock",
      payload: {
        repairedBy,
        stateBefore: workstream.state,
        stateAfter: updated.state,
        cancelledTurns,
        expiredApprovals,
        clearedActiveOperations,
      },
      source: "orchestrator",
    });

    return {
      action: "force-unblock",
      workstreamId: updated.id,
      workstreamName: updated.name,
      stateBefore: workstream.state,
      stateAfter: updated.state,
      cancelledTurns,
      expiredApprovals,
      clearedActiveOperations,
      message: "Cleared stale approvals, running-operation guards, and local running turns.",
    };
  }

  resetWorkstreamToPlanning(workstreamId: string, repairedBy = "system"): WorkstreamRepairResult {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const cancelledTurns = this.markRunningTurnsCancelled(
      workstream.id,
      `Reset to planning by ${repairedBy}; stale running turn was cancelled locally.`,
    );
    const expiredApprovals = approvals.expirePendingByWorkstream(workstream.id, repairedBy);
    const clearedActiveOperations = activeWorkstreamOperations.clear(workstream.id);
    this.activeOperationByWorkstream.delete(workstream.id);

    workstreams.update(workstream.id, {
      state: "planning",
      current_goal: null,
      waiting_on_approval: 0,
      pending_decision: null,
      plan: null,
      planning_context_json: null,
      verification_context_json: null,
      completed_at: null,
    });
    const updated = workstreams.getById(workstream.id) ?? { ...workstream, state: "planning" };

    eventBus.emit("workstream.stateChanged", {
      workstreamId: workstream.id,
      from: workstream.state,
      to: "planning",
      trigger: "repair-reset-to-planning",
    });

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.repair.resetToPlanning",
      payload: {
        repairedBy,
        stateBefore: workstream.state,
        stateAfter: updated.state,
        cancelledTurns,
        expiredApprovals,
        clearedActiveOperations,
      },
      source: "orchestrator",
    });

    return {
      action: "reset-to-planning",
      workstreamId: updated.id,
      workstreamName: updated.name,
      stateBefore: workstream.state,
      stateAfter: updated.state,
      cancelledTurns,
      expiredApprovals,
      clearedActiveOperations,
      message: "Reset state to planning and cleared stale plan, verification, approval, and running-operation state.",
    };
  }

  rebindWorkstreamThread(
    workstreamId: string,
    input: WorkstreamThreadRebindInput,
  ): WorkstreamRepairResult {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    workstreams.update(workstream.id, {
      discord_channel_id: input.channelId,
      discord_thread_id: input.threadId ?? null,
      discord_parent_channel_id: input.parentChannelId ?? null,
    });
    if (input.threadId && input.parentChannelId) {
      const existingBinding = discordThreadBindings.getByThreadId(input.threadId);
      this.upsertDiscordThreadBinding({
        threadId: input.threadId,
        parentChannelId: input.parentChannelId,
        projectId: workstream.project_id,
        epicId: workstream.epic_id,
        lane: this.resolveLaneIdForWorktreeName(workstream),
        baseBranch: workstream.base_branch,
        assistantEnabled: Boolean(existingBinding?.assistant_enabled),
        ownerInstanceId: existingBinding?.owner_instance_id ?? this.instanceId,
        source: "repair",
      });
    }

    const updated = workstreams.getById(workstream.id) ?? workstream;
    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.repair.rebindThread",
      payload: {
        repairedBy: input.reboundBy ?? "system",
        before: {
          channelId: workstream.discord_channel_id,
          threadId: workstream.discord_thread_id,
          parentChannelId: workstream.discord_parent_channel_id,
        },
        after: {
          channelId: updated.discord_channel_id,
          threadId: updated.discord_thread_id,
          parentChannelId: updated.discord_parent_channel_id,
        },
      },
      source: "orchestrator",
    });

    return {
      action: "rebind-thread",
      workstreamId: updated.id,
      workstreamName: updated.name,
      stateBefore: workstream.state,
      stateAfter: updated.state,
      cancelledTurns: 0,
      expiredApprovals: 0,
      clearedActiveOperations: 0,
      message: "Rebound the workstream to the current Discord channel/thread.",
    };
  }

  async retryLatestWorkstreamAction(
    workstreamId: string,
    requestedBy = "system",
  ): Promise<{ action: "plan" | "dispatch"; workstream: WorkstreamRow }> {
    const workstream = workstreams.getById(workstreamId);
    if (!workstream) {
      throw new Error(`Workstream not found: ${workstreamId}`);
    }

    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    if (planningContext?.status === "needs-answers") {
      throw new Error("Planning is waiting on operator answers; retry is blocked until those answers are provided.");
    }

    if (planningContext?.finalExecutionPrompt) {
      await this.dispatch(workstream.id, planningContext.originalInstruction);
      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "workstream.repair.retry",
        payload: { requestedBy, action: "dispatch" },
        source: "orchestrator",
      });
      return { action: "dispatch", workstream: workstreams.getById(workstream.id) ?? workstream };
    }

    const latestTurn = turns.listByWorkstream(workstream.id).at(-1);
    const instruction = latestTurn?.instruction ?? workstream.current_goal ?? workstream.description ?? workstream.name;
    if (latestTurn?.status === "failed" || workstream.current_goal) {
      await this.dispatch(workstream.id, instruction);
      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "workstream.repair.retry",
        payload: { requestedBy, action: "dispatch" },
        source: "orchestrator",
      });
      return { action: "dispatch", workstream: workstreams.getById(workstream.id) ?? workstream };
    }

    await this.generatePlan(workstream.id, instruction, "manual", {
      resumeExisting: Boolean(planningContext),
    });
    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.repair.retry",
      payload: { requestedBy, action: "plan" },
      source: "orchestrator",
    });
    return { action: "plan", workstream: workstreams.getById(workstream.id) ?? workstream };
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
      codexThreadId: this.resolveRuntimeThreadId(workstream) ?? workstream.codex_thread_id,
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
    const threadId = ws ? this.resolveRuntimeThreadId(ws) : null;
    if (!ws || !threadId) {
      throw new Error(`Workstream not found or no runtime thread for approval on ${this.instanceId}: ${approvalId}`);
    }

    const adapter = this.getAdapter(ws.project_id);
    const backendApprovalId = this.extractBackendApprovalId(approval);
    try {
      await adapter.resolveApproval(threadId, backendApprovalId, approved);
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
      threadBindings: this.listDiscordThreadBindings(projectId),
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
      instanceId: this.instanceId,
      projects: this.config.projects.map((project) => ({
        id: project.id,
        name: project.name,
        repoPath: project.repoPath,
        workspaceKind: project.workspaceKind,
        backend: this.adapters.get(project.id)?.name ?? "uninitialized",
        bootstrapCreatedFiles: this.projectBootstrap.get(project.id)?.createdFiles.length ?? 0,
        bootstrapMissingFiles: this.projectBootstrap.get(project.id)?.missingFiles.length ?? 0,
      })),
      activeWorkstreams: workstreams.listActive().length,
      pendingApprovals: approvals.listPending().length,
      timestamp: new Date().toISOString(),
    };
  }

  getAuditReport(scope: "git" | "discord" | "state" | "all" = "all") {
    const includeGit = scope === "git" || scope === "all";
    const includeDiscord = scope === "discord" || scope === "all";
    const includeState = scope === "state" || scope === "all";
    const allBindings = discordThreadBindings.list();
    const allWorkstreams = workstreams.listActive();

    return {
      instanceId: this.instanceId,
      scope,
      generatedAt: new Date().toISOString(),
      projects: this.config.projects.map((project) => {
        const projectWorkstreams = workstreams.listByProject(project.id);
        const projectBindings = allBindings.filter((binding) => binding.project_id === project.id);
        const gitAudit = includeGit ? this.auditGitProject(project, projectWorkstreams) : null;

        return {
          id: project.id,
          name: project.name,
          repoPath: project.repoPath,
          workspaceKind: project.workspaceKind,
          defaultWorktreeBaseBranch: project.defaultWorktreeBaseBranch ?? null,
          productionBranch: project.productionBranch ?? null,
          defaultLanes: project.defaultLanes.map((lane) => ({
            id: lane.id,
            baseBranch: lane.baseBranch,
            ownerInstanceId: lane.ownerInstanceId ?? null,
            assistantEnabled: lane.assistantEnabled,
          })),
          epicBranches: project.epicBranches.map((epic) => ({
            id: epic.id,
            branch: epic.branch,
          })),
          bootstrap: this.projectBootstrap.get(project.id) ?? null,
          activeWorkstreams: includeState
            ? projectWorkstreams
                .filter((workstream) => workstream.state !== "done")
                .map((workstream) => ({
                  id: workstream.id,
                  name: workstream.name,
                  state: workstream.state,
                  workspaceMode: workstream.workspace_mode,
                  cwd: workstream.cwd,
                  branch: workstream.branch,
                  baseBranch: workstream.base_branch,
                }))
            : [],
          threadBindings: includeDiscord
            ? projectBindings.map((binding) => ({
                threadId: binding.thread_id,
                parentChannelId: binding.parent_channel_id,
                epicId: binding.epic_id,
                lane: binding.lane,
                baseBranch: binding.base_branch,
                assistantEnabled: Boolean(binding.assistant_enabled),
                ownerInstanceId: binding.owner_instance_id,
                source: binding.source,
              }))
            : [],
          gitAudit,
        };
      }),
      discord: includeDiscord
        ? {
            routes: this.config.discord.routes.map((route) => ({
              projectId: route.projectId,
              channelId: route.channelId,
              purpose: route.purpose,
              epicId: route.epicId ?? null,
              lane: route.lane ?? null,
              baseBranch: route.baseBranch ?? null,
              assistantEnabled: route.assistantEnabled,
              ownerInstanceId: route.ownerInstanceId ?? null,
            })),
            threadBindingCount: allBindings.length,
          }
        : null,
      state: includeState
        ? {
            activeWorkstreamCount: allWorkstreams.length,
            legacyRootWorkstreams: allWorkstreams
              .filter((workstream) => workstream.workspace_mode === "legacy-root")
              .map((workstream) => ({
                id: workstream.id,
                projectId: workstream.project_id,
                name: workstream.name,
                cwd: workstream.cwd,
              })),
          }
        : null,
    };
  }

  private auditGitProject(project: ProjectConfig, projectWorkstreams: WorkstreamRow[]) {
    if (!this.isGitBackedProject(project)) {
      return {
        mode: "notes",
      };
    }

    const branchOutput = this.readGitOutput(["branch", "--show-current"], project.repoPath).trim();
    const statusOutput = this.readGitOutput(["status", "--short"], project.repoPath).trim();
    const worktreeOutput = this.readGitOutput(["worktree", "list", "--porcelain"], project.repoPath);
    const trackedWorktreePaths = new Set(
      projectWorkstreams
        .filter((workstream) => workstream.workspace_mode === "worktree" && workstream.cwd)
        .map((workstream) => resolve(workstream.cwd!))
    );
    const registeredWorktrees = worktreeOutput.startsWith("Git command failed")
      ? []
      : worktreeOutput
          .split(/\r?\n/)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => resolve(line.slice("worktree ".length).trim()));

    return {
      mode: "git",
      rootBranch: branchOutput.startsWith("Git command failed") ? null : branchOutput,
      rootDirty: Boolean(statusOutput),
      registeredWorktrees,
      orphanedWorktrees: registeredWorktrees.filter((worktreePath) =>
        worktreePath !== resolve(project.repoPath) && !trackedWorktreePaths.has(worktreePath)
      ),
      workstreamMismatches: projectWorkstreams
        .filter((workstream) => workstream.workspace_mode === "worktree")
        .flatMap((workstream) => {
          const mismatches: string[] = [];
          if (!workstream.cwd) {
            mismatches.push("missing cwd");
          } else if (!registeredWorktrees.includes(resolve(workstream.cwd))) {
            mismatches.push("worktree not registered");
          }

          if (workstream.cwd && workstream.branch) {
            const workspaceBranch = this.readGitOutput(["branch", "--show-current"], workstream.cwd).trim();
            if (!workspaceBranch.startsWith("Git command failed") && workspaceBranch !== workstream.branch) {
              mismatches.push(`branch mismatch (${workspaceBranch})`);
            }
          }

          return mismatches.length > 0
            ? [{
                id: workstream.id,
                name: workstream.name,
                issues: mismatches,
              }]
            : [];
        }),
    };
  }

  private beginActiveOperation(
    workstreamId: string,
    kind: ActiveOperationKind,
    startedAt = new Date().toISOString(),
  ): void {
    activeWorkstreamOperations.begin({
      workstream_id: workstreamId,
      operation_kind: kind,
      owner_instance_id: this.instanceId,
      started_at: startedAt,
    });
    this.activeOperationByWorkstream.set(workstreamId, {
      kind,
      startedAt,
      lastProgressAt: startedAt,
    });
  }

  private completeActiveOperation(workstreamId: string): void {
    activeWorkstreamOperations.complete(workstreamId, this.instanceId);
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
    const persisted = activeWorkstreamOperations.touch(workstreamId, kind, this.instanceId, at);
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
        startedAt: persisted.started_at,
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
    return renderMarkdownDocument({
      title: report.headline,
      summary: [report.summary],
      facts: [
        { label: "Generated", value: report.generatedAt },
        { label: "Source event", value: report.sourceEvent },
        { label: "Report kind", value: report.kind },
      ],
      callouts: [
        {
          label: "Next Action",
          body: report.nextAction,
          tone: report.kind === "verification" || report.kind === "review" ? "warning" : "info",
        },
      ],
      sections: [
        {
          title: "What Changed",
          lines: report.filesChanged.map((file) => `- ${file}`),
        },
        {
          title: "Evidence",
          lines: report.validation.map((entry) => {
            const commandSuffix = entry.command ? ` via \`${entry.command}\`` : "";
            return `- [${entry.status}] ${entry.label}: ${entry.detail}${commandSuffix}`;
          }),
        },
        {
          title: "Open Items",
          lines: report.remainingRisks.map((risk) => `- ${risk}`),
        },
      ],
    });
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
    const project = this.getProject(workstream.project_id);
    if (!this.isGitBackedProject(project) || workstream.workspace_mode === "notes") {
      return [];
    }

    const cwd = workstream.cwd ?? project.repoPath;
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

    const persisted = activeWorkstreamOperations.get(workstream.id);
    if (persisted) {
      return {
        kind: persisted.operation_kind as ActiveOperationKind,
        startedAt: persisted.started_at,
        lastProgressAt: persisted.last_seen_at,
        quiet: Date.now() - new Date(persisted.last_seen_at).getTime() >= QUIET_HEALTH_THRESHOLD_MS,
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

  getRuntimeInstanceId() {
    return this.instanceId;
  }

  getDiscordThreadBinding(threadId: string) {
    return discordThreadBindings.getByThreadId(threadId);
  }

  getRepairedDiscordThreadBinding(threadId: string) {
    const binding = discordThreadBindings.getByThreadId(threadId);
    if (!binding) {
      return undefined;
    }

    const result = this.repairDiscordThreadBinding(binding);
    return result.repair.reason ? undefined : result.binding;
  }

  listDiscordThreadBindings(projectId?: string) {
    return projectId ? discordThreadBindings.listByProject(projectId) : discordThreadBindings.list();
  }

  repairDiscordThreadBindings(options?: {
    projectIds?: string[];
    excludeProjectIds?: string[];
  }): {
    changed: DiscordThreadBindingRepair[];
    unchanged: DiscordThreadBindingRepair[];
    unresolved: DiscordThreadBindingRepair[];
  } {
    const projectIds = new Set(options?.projectIds ?? []);
    const excluded = new Set(options?.excludeProjectIds ?? []);
    const results = {
      changed: [] as DiscordThreadBindingRepair[],
      unchanged: [] as DiscordThreadBindingRepair[],
      unresolved: [] as DiscordThreadBindingRepair[],
    };

    for (const binding of discordThreadBindings.list()) {
      if (projectIds.size > 0 && !projectIds.has(binding.project_id)) {
        continue;
      }
      if (excluded.has(binding.project_id)) {
        continue;
      }

      const repair = this.repairDiscordThreadBinding(binding).repair;
      if (repair.changed) {
        results.changed.push(repair);
      } else if (repair.reason) {
        results.unresolved.push(repair);
      } else {
        results.unchanged.push(repair);
      }
    }

    return results;
  }

  private repairDiscordThreadBinding(binding: DiscordThreadBindingRow): {
    binding: DiscordThreadBindingRow;
    repair: DiscordThreadBindingRepair;
  } {
    const before = {
      epicId: binding.epic_id,
      lane: binding.lane,
      baseBranch: binding.base_branch,
    };
    const repairBase: DiscordThreadBindingRepair = {
      threadId: binding.thread_id,
      projectId: binding.project_id,
      changed: false,
      reason: null,
      before,
      after: before,
    };

    let project: ProjectConfig;
    try {
      project = this.getProject(binding.project_id);
    } catch {
      return {
        binding,
        repair: {
          ...repairBase,
          reason: `Unknown project "${binding.project_id}".`,
        },
      };
    }

    const target = this.resolveConfiguredBindingTarget(project, binding);
    if (!target) {
      return {
        binding,
        repair: {
          ...repairBase,
          reason: "Binding does not match a configured lane or epic.",
        },
      };
    }

    const changed =
      target.epicId !== binding.epic_id ||
      target.lane !== binding.lane ||
      target.baseBranch !== binding.base_branch;

    if (!changed) {
      return {
        binding,
        repair: {
          ...repairBase,
          after: target,
        },
      };
    }

    const repaired = discordThreadBindings.upsert({
      thread_id: binding.thread_id,
      parent_channel_id: binding.parent_channel_id,
      project_id: binding.project_id,
      epic_id: target.epicId,
      lane: target.lane,
      base_branch: target.baseBranch,
      assistant_enabled: Boolean(binding.assistant_enabled),
      owner_instance_id: binding.owner_instance_id,
      source: binding.source,
    });

    eventLog.emit({
      project_id: binding.project_id,
      event_type: "discord.threadBindingRepaired",
      payload: {
        threadId: binding.thread_id,
        before,
        after: target,
      },
      source: "orchestrator",
    });

    return {
      binding: repaired,
      repair: {
        ...repairBase,
        changed: true,
        after: target,
      },
    };
  }

  private resolveConfiguredBindingTarget(
    project: ProjectConfig,
    binding: DiscordThreadBindingRow,
  ): DiscordThreadBindingRepair["after"] | null {
    if (binding.epic_id) {
      const epic = project.epicBranches.find((candidate) => candidate.id === binding.epic_id);
      if (epic) {
        return {
          epicId: epic.id,
          lane: workstreamLaneForEpic(epic),
          baseBranch: epic.branch,
        };
      }
    }

    if (binding.lane) {
      const defaultLane = project.defaultLanes.find((candidate) =>
        candidate.id === binding.lane || candidate.baseBranch === binding.lane
      );
      if (defaultLane) {
        return {
          epicId: null,
          lane: defaultLane.id,
          baseBranch: defaultLane.baseBranch,
        };
      }

      const epic = project.epicBranches.find((candidate) =>
        candidate.id === binding.lane ||
        candidate.branch === binding.lane ||
        workstreamLaneForEpic(candidate) === binding.lane
      );
      if (epic) {
        return {
          epicId: epic.id,
          lane: workstreamLaneForEpic(epic),
          baseBranch: epic.branch,
        };
      }
    }

    if (binding.base_branch) {
      const defaultLane = project.defaultLanes.find((candidate) => candidate.baseBranch === binding.base_branch);
      if (defaultLane) {
        return {
          epicId: null,
          lane: defaultLane.id,
          baseBranch: defaultLane.baseBranch,
        };
      }

      const epic = project.epicBranches.find((candidate) => candidate.branch === binding.base_branch);
      if (epic) {
        return {
          epicId: epic.id,
          lane: workstreamLaneForEpic(epic),
          baseBranch: epic.branch,
        };
      }
    }

    return null;
  }

  upsertDiscordThreadBinding(data: {
    threadId: string;
    parentChannelId: string;
    projectId: string;
    epicId?: string | null;
    lane?: string | null;
    baseBranch?: string | null;
    assistantEnabled?: boolean;
    ownerInstanceId?: string | null;
    source?: string;
  }): DiscordThreadBindingRow {
    return discordThreadBindings.upsert({
      thread_id: data.threadId,
      parent_channel_id: data.parentChannelId,
      project_id: data.projectId,
      epic_id: data.epicId ?? null,
      lane: data.lane ?? null,
      base_branch: data.baseBranch ?? null,
      assistant_enabled: data.assistantEnabled ?? false,
      owner_instance_id: data.ownerInstanceId ?? null,
      source: data.source ?? "manual",
    });
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

  private maybeStartAutoFinishAfterVerification(workstream: WorkstreamRow, sourceTurnId: string | null): boolean {
    const project = this.getProject(workstream.project_id);
    if (
      !project.autoFinishAfterVerification ||
      !this.isGitBackedProject(project) ||
      workstream.workspace_mode !== "worktree"
    ) {
      return false;
    }

    void this.finishWorkstream(workstream.id, {
      trigger: "auto",
      finishedBy: "auto-verification",
    }).catch((error) => {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: `Auto-finish failed after verification${sourceTurnId ? ` for turn ${sourceTurnId}` : ""}`,
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
      const workspaceGuard = this.renderExecutionWorkspaceGuard(workstream);
      return [
        workspaceGuard,
        "",
        planningContext.finalExecutionPrompt,
      ].join("\n");
    }

    if (!workstream.plan || workstream.current_goal !== userInstruction) {
      return baseInstruction;
    }

    return [
      this.renderExecutionWorkspaceGuard(workstream),
      "",
      "Approved implementation plan:",
      workstream.plan,
      "",
      "Execute the following instruction using the stored plan above as the primary guide:",
      baseInstruction,
    ].join("\n");
  }

  private renderExecutionWorkspaceGuard(workstream: WorkstreamRow): string {
    const project = this.getProject(workstream.project_id);
    return [
      "Execution workspace rules:",
      `- Canonical repo root (reference-only): ${project.repoPath}`,
      `- Execution workspace (write here): ${this.resolveExecutionWorkspace(workstream)}`,
      `- Workspace mode: ${workstream.workspace_mode}`,
      `- Durable base branch: ${workstream.base_branch ?? project.defaultWorktreeBaseBranch ?? "unknown"}`,
      `- Disposable workstream branch: ${workstream.branch ?? "none"}`,
      "- Do all edits, commands, and commits in the execution workspace. Do not write directly in the canonical repo root unless the workspace mode is notes.",
    ].join("\n");
  }

  private async runClaudeReview(
    workstream: WorkstreamRow,
    target: string,
    sourceTurnId: string | null,
    _maxBudgetUsd: number = 0.75,
  ): Promise<ReviewResult & { verdict?: string }> {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    if (!reviewConfig?.enabled) {
      throw new Error(`Claude review is disabled for project ${project.id}.`);
    }

    const cwd = this.resolveExecutionWorkspace(workstream);
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
          "Epic Context Analysis": epicContextAnalysis ?? "No dynamic epic context generated.",
        },
      },
      {
        model: reviewConfig.model,
        maxTurns: 4,
        permissionMode: "plan",
        maxBudgetUsd: 0.75,
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

  private resolvePlanningAgentModel(project: ProjectConfig, agent: PlanningRoutingAgent): string | undefined {
    const planningConfig = project.claudePlanning;
    const routeKey = PLANNING_AGENT_ROUTE_KEYS[agent];
    const profile = planningConfig?.routing?.agents[routeKey];
    if (profile) {
      return planningConfig?.routing?.profiles[profile];
    }

    return planningConfig?.model;
  }

  private resolveRelatedPlanningProjects(project: ProjectConfig): ProjectConfig[] {
    const relatedIds = new Set([
      ...splitMetadataList(project.metadata?.featured_projects),
      ...splitMetadataList(project.metadata?.related_projects),
      ...splitMetadataList(project.metadata?.planning_related_projects),
    ]);

    relatedIds.delete(project.id);
    return [...relatedIds]
      .map((projectId) => this.config.projects.find((candidate) => candidate.id === projectId))
      .filter((candidate): candidate is ProjectConfig => Boolean(candidate));
  }

  private buildPlanningAddDirs(project: ProjectConfig, cwd: string): string[] {
    const candidates = [
      cwd,
    ];

    return [...new Set(candidates.map((candidate) => resolve(candidate)))]
      .filter((candidate) => existsSync(candidate));
  }

  private renderRelatedPlanningProjects(project: ProjectConfig): string {
    const relatedProjects = this.resolveRelatedPlanningProjects(project);
    if (relatedProjects.length === 0 && !project.metadata) {
      return "No related planning projects configured.";
    }

    const lines = [
      `Current project: ${project.id} (${project.name}) at ${project.repoPath}`,
      project.metadata ? `Current project metadata: ${JSON.stringify(project.metadata)}` : null,
      ...relatedProjects.map((relatedProject) => [
        `Related project: ${relatedProject.id} (${relatedProject.name}) at ${relatedProject.repoPath}`,
        relatedProject.metadata ? `Metadata: ${JSON.stringify(relatedProject.metadata)}` : null,
      ].filter((line): line is string => Boolean(line)).join("\n")),
    ];

    return lines.filter((line): line is string => Boolean(line)).join("\n\n");
  }

  private readPlanningDoc(project: ProjectConfig, relativePath: string): { path: string; content: string } {
    const path = resolve(project.repoPath, relativePath);
    if (!existsSync(path)) {
      return { path, content: "" };
    }

    try {
      return { path, content: readFileSync(path, "utf8") };
    } catch {
      return { path, content: "" };
    }
  }

  private projectMemoryPath(project: ProjectConfig): string {
    return resolve(project.repoPath, "docs", "maverick", "PROJECT_MEMORY.md");
  }

  private readProjectMemory(project: ProjectConfig): { path: string; content: string } {
    const path = this.projectMemoryPath(project);
    if (!existsSync(path)) {
      return { path, content: "" };
    }

    try {
      return { path, content: readFileSync(path, "utf8") };
    } catch {
      return { path, content: "" };
    }
  }

  private projectRoadmapPath(project: ProjectConfig): string {
    return resolve(project.repoPath, "docs", "maverick", "PROJECT_ROADMAP.md");
  }

  private readProjectRoadmap(project: ProjectConfig): { path: string; content: string } {
    const path = this.projectRoadmapPath(project);
    if (!existsSync(path)) {
      return { path, content: "" };
    }

    try {
      return { path, content: readFileSync(path, "utf8") };
    } catch {
      return { path, content: "" };
    }
  }

  private appendProjectMemoryEntry(workstream: WorkstreamRow, completedBy: string): string | null {
    const project = this.getProject(workstream.project_id);
    const path = this.projectMemoryPath(project);
    const planningContext = parsePlanningContextRecord(workstream.planning_context_json);
    const verificationContext = parseVerificationContextRecord(workstream.verification_context_json);
    const latestReport = this.getLatestOperatorReport(workstream.id);
    const latestTurn = this.getLatestStatusTurn(workstream.id);
    const changedFiles = this.collectWorkspaceChangedFiles(workstream).slice(0, 12);
    const now = new Date().toISOString();
    const lines = [
      "",
      `## ${now} - ${workstream.name}`,
      "",
      `- Workstream: ${workstream.id}`,
      `- Completed by: ${completedBy}`,
      workstream.epic_id ? `- Epic: ${workstream.epic_id}` : null,
      workstream.branch ? `- Branch: ${workstream.branch}` : null,
      workstream.summary ? `- Summary: ${workstream.summary}` : null,
      planningContext?.result.recommendedNextSlice
        ? `- Planned slice: ${planningContext.result.recommendedNextSlice}`
        : null,
      latestTurn?.resultSummary ? `- Latest turn: ${latestTurn.resultSummary}` : null,
      verificationContext
        ? `- Verification: ${verificationContext.result.status} (${verificationContext.result.recommendation})`
        : null,
      latestReport?.nextAction ? `- Last next action: ${latestReport.nextAction}` : null,
      changedFiles.length > 0 ? `- Changed files: ${changedFiles.join(", ")}` : null,
    ].filter((line): line is string => line !== null);

    try {
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) {
        writeFileSync(
          path,
          [
            "# Project Memory",
            "",
            "Durable cross-workstream facts, decisions, conventions, blockers, and completion notes recorded by Maverick.",
            "",
          ].join("\n"),
          "utf8",
        );
      }
      appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
      return path;
    } catch (error) {
      eventBus.emit("error", {
        workstreamId: workstream.id,
        error: error instanceof Error ? error : new Error(String(error)),
        context: `Failed to append PROJECT_MEMORY.md for project ${project.id}`,
      });
      return null;
    }
  }

  private hashPlanningInput(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private summarizePlanningDoc(content: string, fallback: string): string {
    const normalized = content.trim();
    if (!normalized) {
      return fallback;
    }

    return normalized.length <= 6000 ? normalized : `${normalized.slice(0, 6000)}\n\n[truncated]`;
  }

  private isPlanningContextRelevantEvent(eventType: string): boolean {
    if (eventType.startsWith("plan.")) {
      return false;
    }
    if (eventType.startsWith("planning.")) {
      // planning.reused, planning.checkpointed etc. — caused by planning itself.
      return false;
    }
    if (eventType === "workstream.stateChanged") {
      // State transitions are byproducts of orchestrator action, not new
      // operator-supplied context. Including them would make the fingerprint
      // change every time planning runs and defeat reuse.
      return false;
    }
    if (eventType === "workstream.autoAdvanced") {
      return false;
    }
    return true;
  }

  private listChangedFilesForPlanning(workstream: WorkstreamRow): PlanningContextBundle["changedFiles"] {
    if (workstream.workspace_mode !== "worktree" || !workstream.base_branch) {
      return [];
    }

    const cwd = this.resolveExecutionWorkspace(workstream);
    const output = this.readGitOutput(["diff", "--name-status", `${workstream.base_branch}...HEAD`], cwd);
    if (output.startsWith("Git command failed")) {
      return [];
    }

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 25)
      .map((line) => {
        const [status, ...pathParts] = line.split(/\s+/);
        const path = pathParts.join(" ");
        return {
          path,
          status: status || "changed",
          summary: `${status || "changed"} ${path}`,
        };
      })
      .filter((entry) => entry.path);
  }

  private buildPlanningContextBundle(
    workstream: WorkstreamRow,
    instruction: string,
    previousContext?: PlanningContextRecord | null,
  ): PlanningContextBundle {
    const project = this.getProject(workstream.project_id);
    const projectDoc = this.readPlanningDoc(project, "docs/maverick/PROJECT_CONTEXT.md");
    const projectMemoryDoc = this.readProjectMemory(project);
    const projectRoadmapDoc = this.readProjectRoadmap(project);
    const epicDoc = workstream.epic_id
      ? this.readPlanningDoc(project, `docs/maverick/epics/${workstream.epic_id}.md`)
      : { path: "", content: "" };
    const agentsMdPath = project.agentsMdPath ?? join(project.repoPath, "AGENTS.md");
    const agentsMd = this.readAgentsMd(project);
    const epic = workstream.epic_id
      ? project.epicBranches.find((candidate) => candidate.id === workstream.epic_id)
      : null;
    const recentEvents = eventLog.listByWorkstream(workstream.id, 25)
      .filter((event) => this.isPlanningContextRelevantEvent(event.event_type))
      .slice(0, 10)
      .map((event) => `${event.created_at}:${event.event_type}`)
      .join("\n");
    const changedFiles = this.listChangedFilesForPlanning(workstream);
    const fingerprintInputs = {
      projectContext: this.hashPlanningInput(projectDoc.content),
      projectMemory: this.hashPlanningInput(projectMemoryDoc.content),
      roadmap: this.hashPlanningInput(projectRoadmapDoc.content),
      epicContext: this.hashPlanningInput(epicDoc.content),
      agentsMd: this.hashPlanningInput(agentsMd),
      projectConfig: this.hashPlanningInput(JSON.stringify({
        id: project.id,
        metadata: project.metadata ?? {},
        epic,
      })),
      workstreamState: this.hashPlanningInput([
        workstream.id,
        workstream.epic_id ?? "",
        workstream.base_branch ?? "",
        recentEvents,
        changedFiles.map((file) => `${file.status}:${file.path}`).join("\n"),
      ].join("\n")),
    };
    const contextFingerprint = this.hashPlanningInput(JSON.stringify(fingerprintInputs));
    const previousContextFingerprint = previousContext?.contextBundle?.contextFingerprint ?? null;
    const fingerprintChanged = previousContextFingerprint !== contextFingerprint;
    const changedEvidence = previousContextFingerprint
      ? Object.entries(fingerprintInputs)
          .filter(([key, value]) => previousContext?.contextBundle?.fingerprintInputs?.[key] !== value)
          .map(([key]) => key)
      : ["no previous planning context fingerprint"];

    return {
      schemaVersion: 1,
      projectContextPath: projectDoc.path || null,
      projectContext: this.summarizePlanningDoc(projectDoc.content, "No durable project context doc is present yet."),
      projectMemoryPath: existsSync(projectMemoryDoc.path) ? projectMemoryDoc.path : null,
      projectMemory: this.summarizePlanningDoc(projectMemoryDoc.content, "No PROJECT_MEMORY.md entries recorded yet."),
      roadmapPath: existsSync(projectRoadmapDoc.path) ? projectRoadmapDoc.path : null,
      roadmap: this.summarizePlanningDoc(
        projectRoadmapDoc.content,
        "No PROJECT_ROADMAP.md is present yet. Ask the operator for direction before recommending a slice.",
      ),
      epicContextPath: epicDoc.path || null,
      epicContext: this.summarizePlanningDoc(epicDoc.content, "No durable epic context doc is present yet."),
      agentsPath: existsSync(agentsMdPath) ? agentsMdPath : null,
      agentsSummary: this.summarizePlanningDoc(agentsMd, "No AGENTS.md doctrine is present yet."),
      contextFingerprint,
      previousContextFingerprint,
      fingerprintChanged,
      fingerprintInputs,
      changedEvidence,
      changedFiles,
      broaderInspectionPolicy: [
        "Use only this bounded context bundle, changed-file summaries, and explicitly provided docs by default.",
        "Do not perform a full repo sweep.",
        "If the changed evidence is insufficient, return needsBroaderInspection with exact paths or search patterns and the reason.",
      ].join(" "),
      boundedAddDirs: this.buildPlanningAddDirs(project, this.resolveExecutionWorkspace(workstream)),
    };
  }

  private planningAgentGuardrails(stage: "scope" | "model" | "plan") {
    return {
      maxBudgetUsd: stage === "plan" ? 0.75 : 0.25,
      // Allow Claude session persistence so successive planning turns benefit from
      // automatic prompt caching on the cached system + context prefix instead of
      // re-tokenizing the full bundle every call.
      noSessionPersistence: false,
      tools: ["Read", "Grep", "Glob"],
      disallowedTools: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"],
      jsonSchema: stage === "plan" ? this.planningResultJsonSchema() : { type: "object" },
    };
  }

  private planningResultJsonSchema(): Record<string, unknown> {
    const decisionSchema = {
      type: "object",
      required: ["id", "question", "whyItMatters"],
      properties: {
        id: { type: "string" },
        question: { type: "string" },
        whyItMatters: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
    };
    return {
      type: "object",
      required: [
        "currentStateSummary",
        "recommendedNextSlice",
        "requiredAnswers",
        "importantDecisions",
        "draftExecutionPrompt",
        "finalExecutionPrompt",
        "remainingUnknowns",
        "steps",
        "risks",
        "dependencies",
        "estimatedTurns",
        "testStrategy",
        "rollbackPlan",
      ],
      properties: {
        currentStateSummary: { type: "string" },
        recommendedNextSlice: { type: "string" },
        requiredAnswers: { type: "array", items: decisionSchema },
        importantDecisions: { type: "array", items: decisionSchema },
        draftExecutionPrompt: { type: "string" },
        finalExecutionPrompt: { type: "string" },
        remainingUnknowns: { type: "array", items: { type: "string" } },
        steps: {
          type: "array",
          items: {
            type: "object",
            required: ["order", "description", "files", "verification", "canParallelize"],
            properties: {
              order: { type: "number" },
              description: { type: "string" },
              files: { type: "array", items: { type: "string" } },
              verification: { type: "string" },
              canParallelize: { type: "boolean" },
            },
          },
        },
        risks: { type: "array", items: { type: "string" } },
        dependencies: { type: "array", items: { type: "string" } },
        estimatedTurns: { type: "number" },
        testStrategy: { type: "string" },
        rollbackPlan: { type: "string" },
      },
    };
  }

  private coercePlanningAgentResult(
    workstream: WorkstreamRow,
    instruction: string,
    agentResult: AgentResult,
    contextBundle: PlanningContextBundle,
  ): PlanningResult {
    if (agentResult.structured) {
      const planningResult = parsePlanningResult(agentResult.structured, agentResult.output);
      this.assertPlanningResultIsActionable(planningResult);
      return planningResult;
    }

    const structured = this.structureRawPlanningOutputForWorkstream(
      workstream,
      instruction,
      agentResult.output,
      contextBundle,
    );
    if (structured) {
      this.assertPlanningResultIsActionable(structured);
      return structured;
    }

    throw new Error(
      [
        "Planning agent returned unstructured output.",
        "Maverick preserved the raw prose, but the deterministic structurer could not find a dispatch-ready prompt or pending questions.",
        "Add a repo-owned Ready Dispatch Prompt or rerun planning with a stricter final prompt request.",
      ].join(" ")
    );
  }

  private assertPlanningResultIsActionable(planningResult: PlanningResult): void {

    const hasBlockingQuestions =
      planningResult.requiredAnswers.length > 0 || planningResult.importantDecisions.length > 0;
    if (!hasBlockingQuestions && !planningResult.finalExecutionPrompt.trim()) {
      throw new Error(
        [
          "Planning agent returned structured JSON but no finalExecutionPrompt and no blocking questions.",
          "A plan must either ask explicit requiredAnswers/importantDecisions or provide a dispatch-ready finalExecutionPrompt.",
        ].join(" ")
      );
    }
  }

  private structureRawPlanningOutputForWorkstream(
    workstream: WorkstreamRow,
    instruction: string,
    rawAgentOutput: string,
    contextBundle?: PlanningContextBundle | null,
  ): PlanningResult | null {
    return structureRawPlanningOutput({
      originalInstruction: instruction,
      rawAgentOutput,
      contextBundle,
      supplementalDocs: this.readPlanningStructureDocs(workstream, instruction),
    });
  }

  private readPlanningStructureDocs(workstream: WorkstreamRow, instruction: string): string[] {
    const project = this.getProject(workstream.project_id);
    const docs = [
      this.readPlanningDoc(project, "docs/maverick/PROJECT_CONTEXT.md").content,
      this.readProjectMemory(project).content,
      workstream.epic_id
        ? this.readPlanningDoc(project, `docs/maverick/epics/${workstream.epic_id}.md`).content
        : "",
    ];

    const planDir = resolve(project.repoPath, "docs", "maverick", "plans");
    if (existsSync(planDir)) {
      const preferredSlugs = new Set([
        this.slugPlanningDocName(workstream.name),
        this.slugPlanningDocName(instruction),
        workstream.epic_id ? this.slugPlanningDocName(workstream.epic_id) : "",
      ].filter(Boolean));
      for (const entry of readdirSync(planDir)) {
        if (!entry.toLowerCase().endsWith(".md")) {
          continue;
        }
        const stem = entry.replace(/\.md$/i, "");
        if (preferredSlugs.size > 0 && !preferredSlugs.has(stem) && preferredSlugs.size < 8) {
          // Include all planning docs only when there is no useful slug signal.
          continue;
        }
        try {
          docs.push(readFileSync(resolve(planDir, entry), "utf8"));
        } catch {
          // Ignore unreadable supplemental planning docs; the raw output remains the source of truth.
        }
      }
    }

    return docs.filter((doc) => doc.trim().length > 0);
  }

  private slugPlanningDocName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private buildCheckpointPlanningResult(
    instruction: string,
    stage: string,
    previous?: PlanningContextRecord | null,
  ): PlanningResult {
    return previous?.result ?? {
      currentStateSummary: `Planning checkpoint saved after ${stage}.`,
      recommendedNextSlice: "Continue bounded planning from the saved checkpoint.",
      requiredAnswers: [],
      importantDecisions: [],
      draftExecutionPrompt: `Planning is not final yet. Original request: ${instruction}`,
      finalExecutionPrompt: "",
      remainingUnknowns: [],
      steps: [],
      risks: [],
      dependencies: [],
      estimatedTurns: 1,
      testStrategy: "Verification strategy has not been finalized yet.",
      rollbackPlan: "No implementation changes have been dispatched from this checkpoint.",
    };
  }

  private checkpointPlanningContext(params: {
    workstream: WorkstreamRow;
    instruction: string;
    stage: string;
    contextBundle: PlanningContextBundle;
    previous?: PlanningContextRecord | null;
    answers?: Record<string, PlanningAnswer>;
  }): PlanningContextRecord {
    const checkpoint = buildPlanningContextRecord({
      originalInstruction: params.instruction,
      result: this.buildCheckpointPlanningResult(params.instruction, params.stage, params.previous),
      rawAgentOutput: `Planning checkpoint saved after ${params.stage}.`,
      contextBundle: params.contextBundle,
      answers: params.answers,
      previous: params.previous,
    });

    workstreams.update(params.workstream.id, {
      planning_context_json: JSON.stringify(checkpoint),
    });
    this.touchProgress("planning", params.workstream.id);
    return checkpoint;
  }

  private async getAgentEpicContextAnalysis(
    workstream: WorkstreamRow,
    model?: string,
  ): Promise<string | null> {
    if (!workstream.epic_id) {
      return null;
    }

    const project = this.getProject(workstream.project_id);
    const cwd = this.resolveExecutionWorkspace(workstream);
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
        addDirs: this.buildPlanningAddDirs(project, cwd),
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

  private buildPlanningAgentContext(
    workstream: WorkstreamRow,
    instruction: string,
    previousContext?: PlanningContextRecord | null,
    answers?: Record<string, PlanningAnswer>,
    epicContextAnalysis?: string | null,
    contextBundle?: PlanningContextBundle,
  ) {
    const project = this.getProject(workstream.project_id);
    const cwd = this.resolveExecutionWorkspace(workstream);
    const recentTurns = turns.listByWorkstream(workstream.id).slice(-5).map((turn) => ({
      instruction: turn.instruction,
      status: turn.status,
      summary: turn.result_summary,
    }));

    return {
      projectId: project.id,
      repoPath: project.repoPath,
      canonicalRepoRoot: project.repoPath,
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
      executionWorkspace: cwd,
      durableBaseBranch: workstream.base_branch ?? project.defaultWorktreeBaseBranch ?? null,
      disposableBranch: workstream.branch,
      workspaceMode: workstream.workspace_mode as "worktree" | "legacy-root" | "notes",
      addDirs: this.buildPlanningAddDirs(project, cwd),
      epicCharter: this.getEpicCharterContext(workstream),
      agentsMd: this.readAgentsMd(project),
      extra: {
        "Bounded Project Context": contextBundle?.projectContext ?? "No bounded project context provided.",
        "Project Memory": contextBundle?.projectMemory ?? "No project memory provided.",
        "Project Roadmap (north star)": contextBundle?.roadmap ?? "No project roadmap provided.",
        "Bounded Epic Context": contextBundle?.epicContext ?? "No bounded epic context provided.",
        "Context Fingerprint": contextBundle ? JSON.stringify({
          contextFingerprint: contextBundle.contextFingerprint,
          previousContextFingerprint: contextBundle.previousContextFingerprint,
          fingerprintChanged: contextBundle.fingerprintChanged,
          changedEvidence: contextBundle.changedEvidence,
          changedFiles: contextBundle.changedFiles,
        }, null, 2) : "No context fingerprint provided.",
        "Broader Inspection Policy": contextBundle?.broaderInspectionPolicy ?? "Use bounded context only unless exact missing evidence is identified.",
        "Recent Turn History": JSON.stringify(recentTurns, null, 2),
        "Current Workstream Summary": workstream.summary ?? "No summary recorded.",
        "Stored Plan Summary": workstream.plan ?? "No stored plan summary.",
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
    const needsAnswers = planningContext.pendingQuestions.length > 0;
    const renderedPlan = renderPlanningSummary(planningContext, {
      includeRawOutput: !needsAnswers,
    });
    const formattedMarkdown = renderedPlan;
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
    const cwd = this.resolveExecutionWorkspace(workstream);
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
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }).trim();
    } catch (error) {
      const result = error as { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString("utf8").trim()
        : typeof result.stderr === "string"
          ? result.stderr.trim()
          : "";
      const stdout = Buffer.isBuffer(result.stdout)
        ? result.stdout.toString("utf8").trim()
        : typeof result.stdout === "string"
          ? result.stdout.trim()
          : "";
      const message = stderr || stdout || (error instanceof Error ? error.message : String(error));
      return `Git command failed (${args.join(" ")}): ${message}`;
    }
  }

  private pushDisposableBranchIfClean(workstream: WorkstreamRow): void {
    if (workstream.workspace_mode !== "worktree" || !workstream.cwd || !workstream.branch) {
      return;
    }

    if (!workstream.branch.startsWith("maverick/")) {
      return;
    }

    const status = this.readGitOutput(["status", "--porcelain"], workstream.cwd);
    if (status.trim() || status.startsWith("Git command failed")) {
      eventLog.emit({
        workstream_id: workstream.id,
        project_id: workstream.project_id,
        event_type: "workstream.branchPushSkipped",
        payload: {
          branch: workstream.branch,
          reason: status.startsWith("Git command failed") ? status : "worktree-dirty",
        },
        source: "orchestrator",
      });
      return;
    }

    const pushOutput = this.readGitOutput(["push", "-u", "origin", `HEAD:refs/heads/${workstream.branch}`], workstream.cwd);
    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: pushOutput.startsWith("Git command failed")
        ? "workstream.branchPushFailed"
        : "workstream.branchPushed",
      payload: {
        branch: workstream.branch,
        output: pushOutput,
        instanceId: this.instanceId,
      },
      source: "orchestrator",
    });
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
      const threadId = this.resolveRuntimeThreadId(ws);
      if (!threadId) {
        throw new Error(`Cannot auto-approve request for ${workstreamId}; no runtime thread on ${this.instanceId}.`);
      }
      await adapter.resolveApproval(threadId, request.id, true);

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
    const allowedRoots = this.allowedWorkstreamRoots(workstream);

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

    const allowedRoots = this.allowedWorkstreamRoots(workstream);

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
    const clearedOperations = activeWorkstreamOperations.clearForOwner(this.instanceId);
    if (clearedOperations > 0) {
      log.warn({ count: clearedOperations, instanceId: this.instanceId }, "Cleared stale active operations for this instance");
    }

    const active = workstreams.listActive();
    if (active.length > 0) {
      log.info({ count: active.length }, "Recovering active workstreams");
      for (const ws of active) {
        const runtimeBinding = workstreamRuntimeBindings.get(ws.id, this.instanceId);
        const threadId = runtimeBinding?.codex_thread_id ?? (this.instanceId === "linux" ? ws.codex_thread_id : null);
        if (threadId) {
          const adapter = this.getAdapter(ws.project_id);
          const thread = await adapter.resumeThread(threadId);
          if (!thread) {
            log.warn({ workstreamId: ws.id, threadId }, "Could not resume thread");
            this.reconcileRecoveredWorkstream(ws, null);
            continue;
          }

          this.reconcileRecoveredWorkstream(ws, thread);
        }
      }
    }
  }

  private reconcileStoredWorkspaceMetadata(): void {
    if (getStateBackendMode() === "remote") {
      return;
    }

    const active = workstreams.listActive();
    if (active.length === 0) {
      return;
    }

    for (const workstream of active) {
      const project = this.getProject(workstream.project_id);
      const updates: Partial<WorkstreamRow> = {};

      if (project.workspaceKind === "notes") {
        if (workstream.workspace_mode !== "notes") {
          updates.workspace_mode = "notes";
        }
      } else {
        const registeredWorktrees = this.readRegisteredWorktreePaths(project.repoPath);
        const normalizedRepoRoot = resolve(project.repoPath);
        const normalizedWorkspace = workstream.cwd ? resolve(workstream.cwd) : null;
        const isRegisteredWorktree =
          normalizedWorkspace !== null &&
          normalizedWorkspace !== normalizedRepoRoot &&
          registeredWorktrees.has(normalizedWorkspace);

        if (isRegisteredWorktree && workstream.workspace_mode !== "worktree") {
          updates.workspace_mode = "worktree";
        }

        if (!workstream.base_branch) {
          if (workstream.epic_id) {
            const epic = project.epicBranches.find((candidate) => candidate.id === workstream.epic_id);
            if (epic) {
              updates.base_branch = epic.branch;
            }
          } else if (project.defaultWorktreeBaseBranch) {
            updates.base_branch = project.defaultWorktreeBaseBranch;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        workstreams.update(workstream.id, updates);
        log.info(
          {
            workstreamId: workstream.id,
            projectId: workstream.project_id,
            updates,
          },
          "Reconciled stored workstream workspace metadata"
        );
      }
    }
  }

  private readRegisteredWorktreePaths(repoPath: string): Set<string> {
    const output = this.readGitOutput(["worktree", "list", "--porcelain"], repoPath);
    if (output.startsWith("Git command failed")) {
      return new Set<string>();
    }

    const worktreePaths = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length).trim()));

    return new Set(worktreePaths);
  }

  private isGitBackedProject(project: ProjectConfig): boolean {
    return project.workspaceKind !== "notes";
  }

  private shouldAllowLegacyRootWorkspace(project: ProjectConfig): boolean {
    const backend = project.executionBackend ?? this.config.defaults.executionBackend;
    return backend.type === "mock";
  }

  private allowedWorkstreamRoots(workstream: WorkstreamRow, options?: { includeCanonicalRoot?: boolean }): string[] {
    const project = this.getProject(workstream.project_id);
    const roots = new Set<string>();

    if (workstream.cwd) {
      roots.add(resolve(workstream.cwd));
    }

    if (options?.includeCanonicalRoot || !this.isGitBackedProject(project)) {
      roots.add(resolve(project.repoPath));
    }

    return [...roots];
  }

  private assertGitBackedExecutionWorkspace(workstream: WorkstreamRow): void {
    const project = this.getProject(workstream.project_id);
    if (!this.isGitBackedProject(project)) {
      return;
    }

    if (this.shouldAllowLegacyRootWorkspace(project)) {
      return;
    }

    if (workstream.workspace_mode !== "worktree") {
      throw new Error(
        `Workstream "${workstream.name}" is in workspace mode "${workstream.workspace_mode}" but git-backed projects must dispatch from a worktree.`
      );
    }

    if (!workstream.cwd) {
      throw new Error(`Workstream "${workstream.name}" has no execution workspace recorded.`);
    }

    if (resolve(workstream.cwd) === resolve(project.repoPath)) {
      throw new Error(
        `Workstream "${workstream.name}" points at the canonical repo root instead of a dedicated execution workspace.`
      );
    }

    if (workstream.branch) {
      const currentBranch = this.readGitOutput(["branch", "--show-current"], workstream.cwd).trim();
      if (currentBranch && !currentBranch.startsWith("Git command failed") && currentBranch !== workstream.branch) {
        throw new Error(
          `Workstream "${workstream.name}" expected branch "${workstream.branch}" but execution workspace is on "${currentBranch}".`
        );
      }
    }

    const worktreeList = this.readGitOutput(["worktree", "list", "--porcelain"], project.repoPath);
    if (!worktreeList.startsWith("Git command failed")) {
      const normalizedWorkspace = resolve(workstream.cwd);
      const registered = worktreeList
        .split(/\r?\n/)
        .some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length).trim()) === normalizedWorkspace);
      if (!registered) {
        throw new Error(
          `Execution workspace "${workstream.cwd}" is not registered as a git worktree for project "${project.id}".`
        );
      }
    }
  }

  private async prepareWorkstreamForDispatch(workstream: WorkstreamRow): Promise<WorkstreamRow> {
    const dispatchWorkstream = await this.ensureDispatchThread(workstream);
    this.assertGitBackedExecutionWorkspace(dispatchWorkstream);
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
    return this.withRuntimeBinding(
      workstreams.getById(dispatchWorkstream.id) ?? dispatchWorkstream,
      workstreamRuntimeBindings.get(dispatchWorkstream.id, this.instanceId),
    );
  }

  private async ensureDispatchThread(workstream: WorkstreamRow): Promise<WorkstreamRow> {
    workstream = await this.ensureLocalRuntimeBinding(workstream, true);
    const adapter = this.getAdapter(workstream.project_id);
    const cwd = this.resolveExecutionWorkspace(workstream);

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
    const binding = workstreamRuntimeBindings.upsert({
      workstream_id: workstream.id,
      instance_id: this.instanceId,
      cwd,
      codex_thread_id: replacementThread.id,
      runtime_status: "idle",
    });
    const updated = this.withRuntimeBinding(workstream, binding);

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

  private async ensureLocalRuntimeBinding(
    workstream: WorkstreamRow,
    requireThread: boolean,
  ): Promise<WorkstreamRow> {
    const existing = workstreamRuntimeBindings.get(workstream.id, this.instanceId);
    if (existing?.cwd && (!requireThread || existing.codex_thread_id)) {
      return this.withRuntimeBinding(workstream, existing);
    }

    const project = this.getProject(workstream.project_id);
    const runtimeOwnerHints = workstreamRuntimeBindings
      .listByWorkstream(workstream.id)
      .map((binding) => binding.instance_id)
      .filter((value) => value !== this.instanceId);

    let workspace;
    try {
      workspace = await recoverWorktreeForBranch({
        repoPath: project.repoPath,
        projectId: workstream.project_id,
        workstreamId: workstream.id,
        name: workstream.name,
        workspaceKind: project.workspaceKind,
        lane: this.resolveLaneIdForWorktreeName(workstream),
        branch: workstream.branch,
      });
    } catch (error) {
      const owners = runtimeOwnerHints.length > 0 ? runtimeOwnerHints.join(", ") : "another host";
      throw new Error(
        [
          `This workstream has no runtime binding for ${this.instanceId}.`,
          `Maverick could not recover the disposable branch locally: ${error instanceof Error ? error.message : String(error)}`,
          `Current runtime owner hint: ${owners}. Finish, cancel, or push the workstream branch from that host before taking it over here.`,
        ].join(" ")
      );
    }

    const adapter = this.getAdapter(workstream.project_id);
    const thread = requireThread ? await adapter.createThread(workspace.cwd) : null;
    const binding = workstreamRuntimeBindings.upsert({
      workstream_id: workstream.id,
      instance_id: this.instanceId,
      cwd: workspace.cwd,
      codex_thread_id: thread?.id ?? existing?.codex_thread_id ?? null,
      runtime_status: "idle",
    });

    eventLog.emit({
      workstream_id: workstream.id,
      project_id: workstream.project_id,
      event_type: "workstream.runtimeBound",
      payload: {
        instanceId: this.instanceId,
        cwd: binding.cwd,
        codexThreadId: binding.codex_thread_id,
        recoveredBranch: workspace.branch,
      },
      source: "orchestrator",
    });

    return this.withRuntimeBinding(workstream, binding);
  }

  private withRuntimeBinding(
    workstream: WorkstreamRow,
    binding: { cwd: string | null; codex_thread_id: string | null } | undefined,
  ): WorkstreamRow {
    if (!binding) {
      return workstream;
    }

    return {
      ...workstream,
      cwd: binding.cwd ?? workstream.cwd,
      codex_thread_id: binding.codex_thread_id ?? workstream.codex_thread_id,
    };
  }

  private syncConfiguredProjects() {
    if (getStateBackendMode() === "remote") {
      return;
    }

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
    return active.find((ws) =>
      ws.codex_thread_id === threadId ||
      workstreamRuntimeBindings.listByWorkstream(ws.id).some((binding) => binding.codex_thread_id === threadId)
    );
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

  private resolveProductionBranch(project: ProjectConfig): string {
    const productionBranch = project.productionBranch ?? project.defaultWorktreeBaseBranch;
    if (!productionBranch) {
      throw new Error(`Project "${project.id}" does not define productionBranch or defaultWorktreeBaseBranch.`);
    }

    return productionBranch;
  }

  private resolveLaneTarget(projectId: string, laneId?: string | null): LaneTarget {
    const project = this.getProject(projectId);
    if (!this.isGitBackedProject(project)) {
      throw new Error(`Project "${project.id}" is not git-backed; lane lifecycle commands require a git project.`);
    }

    const productionBranch = this.resolveProductionBranch(project);
    const requestedLane = laneId?.trim() || null;

    if (requestedLane) {
      const defaultLane = project.defaultLanes.find((lane) =>
        lane.id === requestedLane || lane.baseBranch === requestedLane
      );
      if (defaultLane) {
        return {
          projectId: project.id,
          laneId: defaultLane.id,
          durableBranch: defaultLane.baseBranch,
          productionBranch,
          source: "lane",
        };
      }

      const epic = project.epicBranches.find((candidate) =>
        candidate.id === requestedLane ||
        candidate.branch === requestedLane ||
        workstreamLaneForEpic(candidate) === requestedLane
      );
      if (epic) {
        return {
          projectId: project.id,
          laneId: workstreamLaneForEpic(epic),
          durableBranch: epic.branch,
          productionBranch,
          source: "epic",
        };
      }

      throw new Error(`Project "${project.id}" does not define lane or epic "${requestedLane}".`);
    }

    const laneCandidates: LaneTarget[] = [
      ...project.defaultLanes.map((lane) => ({
        projectId: project.id,
        laneId: lane.id,
        durableBranch: lane.baseBranch,
        productionBranch,
        source: "lane" as const,
      })),
      ...project.epicBranches.map((epic) => ({
        projectId: project.id,
        laneId: workstreamLaneForEpic(epic),
        durableBranch: epic.branch,
        productionBranch,
        source: "epic" as const,
      })),
    ];

    if (laneCandidates.length === 1) {
      return laneCandidates[0];
    }

    const available = laneCandidates
      .map((candidate) => `${candidate.laneId} (${candidate.durableBranch})`)
      .join(", ");
    throw new Error(
      available
        ? `Project "${project.id}" has multiple lanes. Specify one of: ${available}.`
        : `Project "${project.id}" does not define any durable lanes.`
    );
  }

  private resolveLaneTargetForWorkstream(workstream: WorkstreamRow): LaneTarget {
    const project = this.getProject(workstream.project_id);
    const productionBranch = this.resolveProductionBranch(project);

    if (workstream.epic_id) {
      return this.resolveLaneTarget(project.id, workstream.epic_id);
    }

    if (workstream.base_branch) {
      const defaultLane = project.defaultLanes.find((lane) => lane.baseBranch === workstream.base_branch);
      if (defaultLane) {
        return {
          projectId: project.id,
          laneId: defaultLane.id,
          durableBranch: defaultLane.baseBranch,
          productionBranch,
          source: "lane",
        };
      }

      const epic = project.epicBranches.find((candidate) => candidate.branch === workstream.base_branch);
      if (epic) {
        return {
          projectId: project.id,
          laneId: workstreamLaneForEpic(epic),
          durableBranch: epic.branch,
          productionBranch,
          source: "epic",
        };
      }

      return {
        projectId: project.id,
        laneId: workstream.base_branch,
        durableBranch: workstream.base_branch,
        productionBranch,
        source: "lane",
      };
    }

    return this.resolveLaneTarget(project.id);
  }

  private getProject(projectId: string): ProjectConfig {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  private resolveExecutionWorkspace(workstream: WorkstreamRow): string {
    const runtimeBinding = workstreamRuntimeBindings.get(workstream.id, this.instanceId);
    return runtimeBinding?.cwd ?? workstream.cwd ?? this.getProject(workstream.project_id).repoPath;
  }

  private resolveRuntimeThreadId(workstream: WorkstreamRow): string | null {
    const runtimeBinding = workstreamRuntimeBindings.get(workstream.id, this.instanceId);
    return runtimeBinding?.codex_thread_id ?? (this.instanceId === "linux" ? workstream.codex_thread_id : null);
  }

  private resolveLaneIdForWorktreeName(workstream: WorkstreamRow): string | null {
    if (workstream.epic_id) {
      const project = this.getProject(workstream.project_id);
      const epic = project.epicBranches.find((candidate) => candidate.id === workstream.epic_id);
      return epic ? workstreamLaneForEpic(epic) : workstream.epic_id;
    }

    if (workstream.base_branch) {
      const project = this.getProject(workstream.project_id);
      const lane = project.defaultLanes.find((candidate) => candidate.baseBranch === workstream.base_branch);
      if (lane) {
        return lane.id;
      }
    }

    return workstream.base_branch;
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
