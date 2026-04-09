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
  buildBriefInstruction,
  buildBriefSystemPrompt,
  buildPlanningInstruction,
  buildPlanningSystemPrompt,
  buildReviewInstruction,
  buildReviewSystemPrompt,
  cronMatchesDate,
  renderBriefMarkdown,
  scheduledMinuteKey,
  summarizeBrief,
  type BriefTrigger,
  type GeneratedBrief,
} from "../claude/index.js";
import { createLogger } from "../logger.js";
import { eventBus } from "./event-bus.js";
import { WorkstreamStateMachine } from "./state-machine.js";
import { projects, workstreams, turns, approvals, events as eventLog } from "../state/index.js";
import type { WorkstreamRow } from "../state/index.js";
import { createAdapter, type ExecutionBackendAdapter } from "../codex/index.js";
import type { ApprovalRequest, ExecutionThread, ReviewResult } from "../codex/types.js";
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
    const ws = workstreams.getById(workstreamId);
    if (!ws) throw new Error(`Workstream not found: ${workstreamId}`);

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
        instruction: executionInstruction,
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
        payload: {
          turnId: turn.id,
          status: result.status,
          summary: result.summary ?? null,
          output: result.output,
        },
        source: "orchestrator",
      });

      this.maybeStartAutoClaudeReview(dispatchWorkstream, turn.id, result.status);
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

    this.maybeStartAutoClaudePlan(workstreams.getById(workstreamId) ?? { ...ws, state: newState });
    log.info({ workstreamId, from: ws.state, to: newState, trigger }, "State transitioned");
    return newState;
  }

  async review(
    workstreamId: string,
    target?: string,
    options?: { reviewer?: "primary" | "claude"; trigger?: "manual" | "auto" }
  ) {
    const ws = workstreams.getById(workstreamId);
    if (!ws?.codex_thread_id) throw new Error(`Workstream not found or no thread: ${workstreamId}`);

    const reviewer = options?.reviewer ?? "primary";
    const effectiveTarget = target ?? "uncommitted";
    const result =
      reviewer === "claude"
        ? await this.runClaudeReview(ws, effectiveTarget)
        : await this.getAdapter(ws.project_id).startReview({
            threadId: ws.codex_thread_id,
            cwd: ws.cwd ?? this.getProject(ws.project_id).repoPath,
            target: effectiveTarget,
          });

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

  async generatePlan(workstreamId: string, instruction: string, trigger: "manual" | "auto" = "manual") {
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
    const thread = await adapter.createThread(cwd);
    const plan = await adapter.startTurn({
      threadId: thread.id,
      cwd,
      model: planningConfig.model,
      systemPrompt: buildPlanningSystemPrompt(),
      instruction: buildPlanningInstruction({
        projectId: project.id,
        workstreamName: workstream.name,
        instruction,
        agentsMd: this.readAgentsMd(project),
        directoryTree: this.buildDirectoryTree(cwd),
        recentTurnHistory: turns.listByWorkstream(workstreamId).slice(-5).map((turn) => ({
          instruction: turn.instruction,
          status: turn.status,
          summary: turn.result_summary,
        })),
        epicCharter: this.getEpicCharterContext(workstream),
      }),
      addDirs: [cwd],
      maxTurns: 3,
      permissionMode: "plan",
    });

    if (plan.status !== "completed") {
      throw new Error(plan.output || "Claude plan generation failed.");
    }

    workstreams.update(workstreamId, {
      current_goal: instruction,
      plan: plan.output.trim(),
      summary: trigger === "manual" ? "Claude plan stored for the next dispatch." : "Claude auto-plan stored for the planning state.",
    });

    eventLog.emit({
      workstream_id: workstreamId,
      project_id: workstream.project_id,
      event_type: "plan.generated",
      payload: {
        trigger,
        instruction,
        length: plan.output.length,
      },
      source: "orchestrator",
    });

    return plan.output.trim();
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

  private maybeStartAutoClaudeReview(workstream: WorkstreamRow, turnId: string, turnStatus: string): void {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    const primaryAdapter = this.getAdapter(workstream.project_id);

    if (
      !reviewConfig?.enabled ||
      !reviewConfig.autoAfterTurn ||
      turnStatus !== "completed" ||
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

  private async runClaudeReview(workstream: WorkstreamRow, target: string): Promise<ReviewResult> {
    const project = this.getProject(workstream.project_id);
    const reviewConfig = project.claudeReview;
    if (!reviewConfig?.enabled) {
      throw new Error(`Claude review is disabled for project ${project.id}.`);
    }

    const cwd = workstream.cwd ?? project.repoPath;
    const latestTurn = turns.listByWorkstream(workstream.id).slice(-1)[0] ?? null;
    const adapter = await this.getUtilityClaudeAdapter();
    const reviewThread = await adapter.createThread(cwd);

    return adapter.startReview({
      threadId: reviewThread.id,
      cwd,
      target,
      model: reviewConfig.model,
      systemPrompt: buildReviewSystemPrompt(),
      instruction: buildReviewInstruction({
        projectId: project.id,
        workstreamName: workstream.name,
        instruction: latestTurn?.instruction ?? workstream.current_goal ?? "No recorded instruction.",
        turnSummary: latestTurn?.result_summary ?? workstream.summary,
        turnOutput: this.getLatestTurnOutput(workstream.id, latestTurn?.result_summary ?? workstream.summary ?? ""),
        gitDiff: this.readGitReviewDiff(cwd, target),
        gitStatus: this.readGitOutput(["status", "--short", "--branch"], cwd),
        epicCharter: this.getEpicCharterContext(workstream),
        testResults: null,
      }),
      addDirs: [cwd],
      maxTurns: 3,
      permissionMode: "plan",
    });
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
    const thread = await adapter.createThread(cwd);
    const turnResult = await adapter.startTurn({
      threadId: thread.id,
      instruction: buildBriefInstruction(context),
      cwd,
      model: this.config.brief.model,
      systemPrompt: buildBriefSystemPrompt(),
      addDirs: repoPaths,
      maxTurns: 10,
      permissionMode: "auto",
    });

    if (turnResult.status !== "completed") {
      throw new Error(turnResult.output || "Claude brief generation failed.");
    }

    const content = turnResult.output.trim();
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
