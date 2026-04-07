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
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { createLogger } from "../logger.js";
import { eventBus } from "./event-bus.js";
import { WorkstreamStateMachine } from "./state-machine.js";
import { projects, workstreams, turns, approvals, events as eventLog } from "../state/index.js";
import type { WorkstreamRow } from "../state/index.js";
import { createAdapter, type ExecutionBackendAdapter } from "../codex/index.js";
import type { ApprovalRequest, ExecutionThread } from "../codex/types.js";
import type { EscalationTier, OrchestratorConfig, ProjectConfig, RemoteHostConfig } from "../config/schema.js";
import { ensureProjectBootstrap, ensureWorktreeBootstrap, type BootstrapStatus } from "../projects/bootstrap.js";
import { buildEpicCharterContext, requireEpicById, workstreamLaneForEpic } from "../projects/epics.js";
import { provisionWorktree } from "../git/worktree.js";

const log = createLogger("orchestrator");

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

export class Orchestrator {
  private config: OrchestratorConfig;
  private adapters: Map<string, ExecutionBackendAdapter> = new Map();
  private stateMachines: Map<string, WorkstreamStateMachine> = new Map();
  private activeTurnByWorkstream = new Map<string, string>();
  private projectBootstrap = new Map<string, BootstrapStatus>();
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
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

    const dispatchWorkstream = await this.prepareWorkstreamForDispatch(ws);
    const adapter = this.getAdapter(dispatchWorkstream.project_id);
    const preparedInstruction = this.prepareTurnInstruction(dispatchWorkstream, instruction);

    // Create turn record
    const turn = turns.create({
      workstream_id: workstreamId,
      instruction,
    });
    this.activeTurnByWorkstream.set(workstreamId, turn.id);

    turns.update(turn.id, {
      status: "running",
      started_at: new Date().toISOString(),
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
        instruction: preparedInstruction.instruction,
        cwd: dispatchWorkstream.cwd ?? this.getProject(dispatchWorkstream.project_id).repoPath,
      });

      // Update turn
      turns.update(turn.id, {
        codex_turn_id: result.backendTurnId,
        status: result.status,
        result_summary: result.summary,
        completed_at: new Date().toISOString(),
      });

      // Update workstream summary
      workstreams.update(workstreamId, {
        summary: result.summary,
      });

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
        payload: { turnId: turn.id, status: result.status },
        source: "orchestrator",
      });

      this.activeTurnByWorkstream.delete(workstreamId);
      log.info({ workstreamId, turnId: turn.id, status: result.status }, "Turn completed");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      turns.update(turn.id, {
        status: "failed",
        result_summary: message,
        completed_at: new Date().toISOString(),
      });

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
      throw err;
    }
  }

  async steer(workstreamId: string, instruction: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws?.codex_thread_id) throw new Error(`Workstream not found or no thread: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    await adapter.steerTurn({ threadId: ws.codex_thread_id, instruction });

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

    const sm = this.getStateMachine(ws.project_id);
    const newState = sm.transition(ws.state, trigger);

    workstreams.update(workstreamId, {
      state: newState,
      completed_at: sm.isTerminal(newState) ? new Date().toISOString() : undefined,
    });

    eventBus.emit("workstream.stateChanged", {
      workstreamId,
      from: ws.state,
      to: newState,
      trigger,
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "workstream.stateChanged",
      payload: { from: ws.state, to: newState, trigger },
      source: "orchestrator",
    });

    log.info({ workstreamId, from: ws.state, to: newState, trigger }, "State transitioned");
    return newState;
  }

  async review(workstreamId: string, target?: string) {
    const ws = workstreams.getById(workstreamId);
    if (!ws?.codex_thread_id) throw new Error(`Workstream not found or no thread: ${workstreamId}`);

    const adapter = this.getAdapter(ws.project_id);
    const result = await adapter.startReview({
      threadId: ws.codex_thread_id,
      cwd: ws.cwd ?? this.getProject(ws.project_id).repoPath,
      target: target ?? "uncommitted",
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: ws.project_id,
      event_type: "review.completed",
      payload: { severity: result.severity, findingsLength: result.findings.length },
      source: "orchestrator",
    });

    return result;
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

    const stillPending = approvals.listPending(ws.id);
    if (stillPending.length === 0) {
      workstreams.update(ws.id, {
        waiting_on_approval: 0,
        pending_decision: null,
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

  // --- Internal ---

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
      workstreams.update(workstreamId, { waiting_on_approval: 0, pending_decision: null });

      const adapter = this.getAdapter(ws.project_id);
      await adapter.resolveApproval(ws.codex_thread_id!, request.id, true);

      eventBus.emit("approval.resolved", {
        workstreamId,
        approvalId: approval.id,
        status: "approved",
        decidedBy: "auto",
      });

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
      return "auto";
    }

    return "approval-gated";
  }

  private buildApprovalContextText(request: ApprovalRequest): string {
    return [request.description, ...collectContextStrings(request.context)].join("\n");
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
        pending_decision: null,
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
    if (!workstream.epic_id) {
      return {
        instruction: userInstruction,
        epicContextInjected: false,
      };
    }

    const project = this.getProject(workstream.project_id);
    const epic = project.epicBranches.find((candidate) => candidate.id === workstream.epic_id);
    if (!epic) {
      log.warn(
        { projectId: project.id, workstreamId: workstream.id, epicId: workstream.epic_id },
        "Workstream references an epic that no longer exists in config"
      );
      return {
        instruction: userInstruction,
        epicContextInjected: false,
      };
    }

    const epicContext = buildEpicCharterContext(project, epic);
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
}
