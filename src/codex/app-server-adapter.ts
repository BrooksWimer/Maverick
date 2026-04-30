import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { resolve } from "node:path";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { createLogger } from "../logger.js";
import type {
  ApprovalRequest,
  ExecutionBackendAdapter,
  ExecutionInputItem,
  ExecutionThread,
  ReviewRequest,
  ReviewResult,
  SteerRequest,
  TurnRequest,
  TurnResult,
} from "./types.js";

const log = createLogger("codex-app-server");

type JsonRpcId = number | string;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type PendingApproval = {
  threadId: string;
  requestMethod: string;
  requestId: JsonRpcId;
  params: Record<string, unknown>;
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  outputParts: string[];
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
};

type AppServerOptions = {
  transport?: "stdio" | "websocket";
  model?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  nodePath?: string;
  codexJsPath?: string;
  websocketPort?: number;
  persistExtendedHistory?: boolean;
  experimentalRawEvents?: boolean;
};

type ThreadStatusPayload =
  | { type: "notLoaded" | "idle" | "systemError" }
  | { type: "active"; activeFlags?: string[] };

type ThreadRecord = {
  id: string;
  cwd: string;
  status: ThreadStatusPayload;
  path?: string | null;
};

type TurnReadRecord = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message?: string } | null;
  items?: Array<Record<string, unknown>>;
};

function textInput(text: string) {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function imageInput(imageUrl: string) {
  return {
    type: "image",
    image_url: imageUrl,
  };
}

function localImageInput(path: string) {
  return {
    type: "local_image",
    path,
  };
}

function buildInputItems(inputItems: ExecutionInputItem[] | undefined, fallbackInstruction: string) {
  if (!inputItems || inputItems.length === 0) {
    return [textInput(fallbackInstruction)];
  }

  return inputItems.map((item) => {
    switch (item.type) {
      case "image":
        return imageInput(item.imageUrl);
      case "local_image":
        return localImageInput(item.path);
      case "text":
      default:
        return textInput(item.text);
    }
  });
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function dedupeWindowsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return { ...env };
  }

  const sanitized: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    const normalizedKey = key.toLowerCase() === "path" ? "PATH" : key;
    sanitized[normalizedKey] = value;
  }

  if (!sanitized.PATH) {
    const fallbackPath = env.PATH ?? env.Path;
    if (fallbackPath) {
      sanitized.PATH = fallbackPath;
    }
  }

  return sanitized;
}

function resolveGlobalNpmRoot(): string | null {
  try {
    const result = execFileSync("npm", ["root", "-g"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

function resolvePosixCodexJsPath(): string | null {
  const npmRoot = resolveGlobalNpmRoot();
  const candidates = [
    npmRoot ? resolve(npmRoot, "@openai", "codex", "bin", "codex.js") : null,
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
    "/usr/lib/node_modules/@openai/codex/bin/codex.js",
    "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveDefaultCodexJsPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const candidate = resolve(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const posixPath = resolvePosixCodexJsPath();
  if (posixPath) {
    return posixPath;
  }

  throw new Error(
    "Unable to locate codex.js automatically. Set CODEX_JS_PATH or executionBackend.codexJsPath."
  );
}

function summarizeOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}...`;
}

function isCodexStateDbWarning(line: string): boolean {
  return (
    /failed to open state db/i.test(line) ||
    /migration .*missing in the resolved migrations/i.test(line) ||
    /migration \d+ (?:missing|was previously applied)/i.test(line)
  );
}

const CODEX_STATE_DB_FILES = ["state_5.sqlite", "state_5.sqlite-shm", "state_5.sqlite-wal"];

function archiveCorruptCodexStateDb(logger: ReturnType<typeof createLogger>): string[] {
  const codexDir = resolve(homedir(), ".codex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived: string[] = [];

  for (const filename of CODEX_STATE_DB_FILES) {
    const source = resolve(codexDir, filename);
    if (!existsSync(source)) {
      continue;
    }
    const target = `${source}.broken-${stamp}`;
    try {
      renameSync(source, target);
      archived.push(target);
    } catch (error) {
      logger.error({ err: error, source, target }, "Failed to archive corrupt codex state db file");
    }
  }

  return archived;
}

export class CodexAppServerAdapter implements ExecutionBackendAdapter {
  readonly name = "codex-app-server";

  private readonly options: Required<Pick<AppServerOptions, "transport" | "sandboxMode" | "approvalPolicy" | "persistExtendedHistory" | "experimentalRawEvents" | "websocketPort">> &
    Pick<AppServerOptions, "model" | "nodePath" | "codexJsPath">;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutLines: ReadLineInterface | null = null;
  private stderrLines: ReadLineInterface | null = null;
  private initialized = false;
  private shuttingDown = false;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingTurns = new Map<string, PendingTurn>();
  private activeTurnByThread = new Map<string, string>();
  private threads = new Map<string, ExecutionThread>();
  private outputCallbacks: Array<(threadId: string, content: string, isPartial: boolean) => void> = [];
  private approvalCallbacks: Array<(threadId: string, request: ApprovalRequest) => void> = [];
  private stateDbHealAttempted = false;
  private stateDbHealing: Promise<void> | null = null;

  constructor(options: AppServerOptions = {}) {
    this.options = {
      transport: options.transport ?? "stdio",
      model: options.model,
      sandboxMode: options.sandboxMode ?? "workspace-write",
      approvalPolicy: options.approvalPolicy ?? "on-request",
      nodePath: options.nodePath,
      codexJsPath: options.codexJsPath,
      websocketPort: options.websocketPort ?? 8765,
      persistExtendedHistory: options.persistExtendedHistory ?? true,
      experimentalRawEvents: options.experimentalRawEvents ?? false,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.shuttingDown = false;

    if (this.options.transport !== "stdio") {
      throw new Error("Codex App Server websocket transport is not implemented yet. Use transport=stdio.");
    }

    this.startProcess();
    await this.performInitializeHandshake();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.initialized = false;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server adapter shutting down"));
    }
    this.pendingRequests.clear();

    for (const turn of this.pendingTurns.values()) {
      turn.reject(new Error("Codex App Server adapter shutting down"));
    }
    this.pendingTurns.clear();
    this.pendingApprovals.clear();
    this.activeTurnByThread.clear();
    this.threads.clear();

    this.stdoutLines?.close();
    this.stderrLines?.close();
    this.stdoutLines = null;
    this.stderrLines = null;

    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
    }
    this.process = null;
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    await this.ensureInitialized();

    const result = asObject(await this.sendRequest("thread/start", {
      cwd,
      model: this.options.model ?? null,
      approvalPolicy: this.options.approvalPolicy,
      sandbox: this.options.sandboxMode,
      serviceName: "maverick",
      ephemeral: false,
      experimentalRawEvents: this.options.experimentalRawEvents,
      persistExtendedHistory: this.options.persistExtendedHistory,
    }));

    const thread = this.toExecutionThread(asObject(result.thread));
    this.threads.set(thread.id, thread);
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    await this.ensureInitialized();

    try {
      const result = asObject(await this.sendRequest("thread/resume", {
        threadId,
        persistExtendedHistory: this.options.persistExtendedHistory,
      }));

      const thread = this.toExecutionThread(asObject(result.thread));
      this.threads.set(thread.id, thread);
      return thread;
    } catch (error) {
      log.warn({ err: error, threadId }, "Failed to resume Codex thread");
      return null;
    }
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    await this.ensureThreadAvailable(request.threadId);

    const response = asObject(await this.sendRequest("turn/start", {
      threadId: request.threadId,
      input: buildInputItems(request.inputItems, request.instruction),
      cwd: request.cwd,
      model: request.model ?? this.options.model ?? null,
    }));

    const turn = asObject(response.turn);
    const turnId = coerceString(turn.id);
    if (!turnId) {
      throw new Error("Codex App Server did not return a turn id");
    }

    const result = await new Promise<TurnResult>((resolve, reject) => {
      this.pendingTurns.set(turnId, {
        threadId: request.threadId,
        turnId,
        outputParts: [],
        resolve,
        reject,
      });
    });

    return {
      ...result,
      backendTurnId: turnId,
    };
  }

  async steerTurn(request: SteerRequest): Promise<void> {
    await this.ensureThreadAvailable(request.threadId);

    const activeTurnId = this.activeTurnByThread.get(request.threadId);
    if (!activeTurnId) {
      throw new Error(`No active turn to steer for thread ${request.threadId}`);
    }

    await this.sendRequest("turn/steer", {
      threadId: request.threadId,
      expectedTurnId: activeTurnId,
      input: [textInput(request.instruction)],
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.ensureThreadAvailable(threadId);

    const activeTurnId = this.activeTurnByThread.get(threadId);
    if (!activeTurnId) {
      return;
    }

    await this.sendRequest("turn/interrupt", {
      threadId,
      turnId: activeTurnId,
    });
  }

  async resolveApproval(_threadId: string, approvalId: string, approved: boolean): Promise<void> {
    await this.ensureInitialized();

    let pendingKey = approvalId;
    let pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      const matchingEntries = [...this.pendingApprovals.entries()].filter(
        ([, candidate]) => candidate.threadId === _threadId
      );

      if (matchingEntries.length === 1) {
        [pendingKey, pending] = matchingEntries[0];
        log.warn(
          { threadId: _threadId, requestedApprovalId: approvalId, backendApprovalId: pendingKey },
          "Falling back to the only pending backend approval for this thread"
        );
      }
    }

    if (!pending) {
      throw new Error(`Unknown approval request: ${approvalId}`);
    }

    let result: Record<string, unknown>;

    switch (pending.requestMethod) {
      case "item/commandExecution/requestApproval":
        result = { decision: approved ? "accept" : "decline" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: approved ? "accept" : "decline" };
        break;
      case "item/permissions/requestApproval": {
        const permissions = asObject(pending.params.permissions);
        result = approved
          ? {
              permissions: {
                ...(permissions.network ? { network: permissions.network } : {}),
                ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
              },
              scope: "turn",
            }
          : {
              permissions: {},
              scope: "turn",
            };
        break;
      }
      default:
        throw new Error(`Approval resolution for ${pending.requestMethod} is not implemented yet`);
    }

      this.sendResponse(pending.requestId, result);
    this.pendingApprovals.delete(pendingKey);
  }

  async startReview(request: ReviewRequest): Promise<ReviewResult> {
    await this.ensureThreadAvailable(request.threadId);

    const result = asObject(await this.sendRequest("review/start", {
      threadId: request.threadId,
      target: this.toReviewTarget(request.target),
    }));

    const turn = asObject(result.turn);
    const turnId = coerceString(turn.id);
    const reviewThreadId = coerceString(result.reviewThreadId) ?? request.threadId;

    if (!turnId) {
      throw new Error("Codex App Server did not return a review turn id");
    }

    const turnResult = await new Promise<TurnResult>((resolve, reject) => {
      this.pendingTurns.set(turnId, {
        threadId: reviewThreadId,
        turnId,
        outputParts: [],
        resolve,
        reject,
      });
    });

    const severity = turnResult.status === "failed" ? "major" : "clean";

    return {
      findings: turnResult.output,
      severity,
      suggestions: [],
    };
  }

  onOutput(callback: (threadId: string, content: string, isPartial: boolean) => void): void {
    this.outputCallbacks.push(callback);
  }

  onApprovalRequest(callback: (threadId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(callback);
  }

  async listThreads(cwd?: string): Promise<ThreadRecord[]> {
    await this.ensureInitialized();
    const result = asObject(await this.sendRequest("thread/list", cwd ? { cwd } : {}));
    const data = Array.isArray(result.data) ? result.data : [];
    return data.map((entry) => {
      const thread = asObject(entry);
      return {
        id: coerceString(thread.id) ?? "",
        cwd: coerceString(thread.cwd) ?? "",
        status: asObject(thread.status) as ThreadStatusPayload,
        path: coerceString(thread.path) ?? null,
      };
    });
  }

  async readThread(threadId: string, includeTurns = false): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    const result = asObject(await this.sendRequest("thread/read", {
      threadId,
      includeTurns,
    }));
    return asObject(result.thread);
  }

  private startProcess(): void {
    const nodePath = nonEmpty(this.options.nodePath) ?? nonEmpty(process.env.CODEX_NODE_PATH) ?? process.execPath;
    const codexJsPath =
      nonEmpty(this.options.codexJsPath) ??
      nonEmpty(process.env.CODEX_JS_PATH) ??
      resolveDefaultCodexJsPath();

    const env = dedupeWindowsEnv(process.env);
    const args = [codexJsPath, "app-server"];

    if (this.options.transport === "websocket") {
      args.push("--listen", `ws://127.0.0.1:${this.options.websocketPort}`);
    }

    log.info({ nodePath, codexJsPath, transport: this.options.transport }, "Starting codex app-server");

    this.process = spawn(nodePath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.on("error", (error) => {
      this.handleTransportFailure(error);
    });

    this.process.on("exit", (code, signal) => {
      this.handleTransportFailure(
        new Error(`Codex App Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`)
      );
    });

    this.stdoutLines = createInterface({ input: this.process.stdout });
    this.stdoutLines.on("line", (line) => {
      void this.handleIncomingLine(line);
    });

    this.stderrLines = createInterface({ input: this.process.stderr });
    this.stderrLines.on("line", (line) => {
      if (isCodexStateDbWarning(line)) {
        if (!this.stateDbHealAttempted && !this.stateDbHealing) {
          this.stateDbHealAttempted = true;
          log.error({ line }, "codex app-server state database is corrupt; archiving and recreating");
          this.stateDbHealing = this.healStateDatabase().catch((error) => {
            log.error({ err: error }, "Failed to heal codex state database");
          });
          return;
        }

        if (this.stateDbHealAttempted) {
          log.error({ line }, "codex state db error persists after heal attempt");
        }
        return;
      }

      log.warn({ line }, "codex app-server stderr");
    });
  }

  private async healStateDatabase(): Promise<void> {
    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGTERM");
      } catch (error) {
        log.warn({ err: error }, "Failed to terminate codex process before state db heal");
      }
    }

    this.process = null;
    this.initialized = false;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex state database is being recreated; retry once heal completes"));
    }
    this.pendingRequests.clear();

    for (const turn of this.pendingTurns.values()) {
      turn.reject(new Error("Codex state database is being recreated; retry once heal completes"));
    }
    this.pendingTurns.clear();
    this.pendingApprovals.clear();
    this.activeTurnByThread.clear();

    const archived = archiveCorruptCodexStateDb(log);
    if (archived.length > 0) {
      log.warn({ archived }, "Archived corrupt codex state database files");
    } else {
      log.warn("No codex state database files found to archive (already removed?)");
    }

    this.stateDbHealing = null;
  }

  private async handleIncomingLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;

    try {
      message = JSON.parse(trimmed) as JsonRpcNotification | JsonRpcRequest | JsonRpcResponse;
    } catch (error) {
      log.warn({ line, err: error }, "Received non-JSON line from codex app-server");
      return;
    }

    if ("method" in message && "id" in message) {
      await this.handleServerRequest(message as JsonRpcRequest);
      return;
    }

    if ("method" in message) {
      this.handleNotification(message as JsonRpcNotification);
      return;
    }

    if ("id" in message) {
      this.handleResponse(message as JsonRpcResponse);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const key = String(message.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(key);

    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const requestId = String(message.id);
    const params = asObject(message.params);

    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const approval = this.toApprovalRequest(message.method, params, requestId);
        this.pendingApprovals.set(approval.id, {
          threadId: approval.context.threadId as string,
          requestMethod: message.method,
          requestId: message.id,
          params,
        });

        for (const callback of this.approvalCallbacks) {
          callback(approval.context.threadId as string, approval);
        }
        return;
      }
      case "item/tool/requestUserInput":
        for (const callback of this.approvalCallbacks) {
          callback(coerceString(params.threadId) ?? "", {
            id: requestId,
            type: "user-input",
            description: coerceString(params.reason) ?? "Codex requested user input",
            context: {
              threadId: coerceString(params.threadId) ?? "",
              requestMethod: message.method,
              ...params,
            },
          });
        }
        return;
      default:
        this.sendErrorResponse(message.id, -32601, `Unsupported server request: ${message.method}`);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    const params = asObject(message.params);

    switch (message.method) {
      case "thread/status/changed": {
        const threadId = coerceString(params.threadId);
        if (!threadId) {
          return;
        }
        const known = this.threads.get(threadId);
        if (known) {
          known.status = this.toExecutionStatus(asObject(params.status));
          this.threads.set(threadId, known);
        }
        break;
      }
      case "turn/started": {
        const threadId = coerceString(params.threadId);
        const turn = asObject(params.turn);
        const turnId = coerceString(turn.id);
        if (threadId && turnId) {
          this.activeTurnByThread.set(threadId, turnId);
          const known = this.threads.get(threadId);
          if (known) {
            known.status = "active";
            this.threads.set(threadId, known);
          }
        }
        break;
      }
      case "item/agentMessage/delta": {
        const threadId = coerceString(params.threadId);
        const turnId = coerceString(params.turnId);
        const delta = coerceString(params.delta) ?? "";
        if (!threadId || !turnId || !delta) {
          return;
        }

        const pendingTurn = this.pendingTurns.get(turnId);
        if (pendingTurn) {
          pendingTurn.outputParts.push(delta);
        }

        for (const callback of this.outputCallbacks) {
          callback(threadId, delta, true);
        }
        break;
      }
      case "turn/completed": {
        const threadId = coerceString(params.threadId);
        const turn = asObject(params.turn);
        const turnId = coerceString(turn.id);
        if (!threadId || !turnId) {
          return;
        }

        const pendingTurn = this.pendingTurns.get(turnId);
        this.activeTurnByThread.delete(threadId);

        const known = this.threads.get(threadId);
        if (known) {
          known.status = "idle";
          this.threads.set(threadId, known);
        }

        if (!pendingTurn) {
          return;
        }

        this.pendingTurns.delete(turnId);

        void this.resolveCompletedTurn(threadId, pendingTurn, turn as TurnReadRecord);
        break;
      }
      default:
        break;
    }
  }

  private async resolveCompletedTurn(threadId: string, pendingTurn: PendingTurn, turn: TurnReadRecord): Promise<void> {
    try {
      const thread = await this.readThread(threadId, true);
      const turns = Array.isArray(thread.turns) ? (thread.turns as TurnReadRecord[]) : [];
      const fullTurn = turns.find((entry) => entry.id === pendingTurn.turnId) ?? turn;

      const output = this.extractAgentOutput(fullTurn) || pendingTurn.outputParts.join("");
      const filesChanged = this.extractFilesChanged(fullTurn);

      pendingTurn.resolve({
        status: this.toTurnResultStatus(fullTurn.status),
        output,
        summary: summarizeOutput(output),
        filesChanged,
      });
    } catch (error) {
      pendingTurn.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private extractAgentOutput(turn: TurnReadRecord): string {
    const items = Array.isArray(turn.items) ? turn.items : [];
    const chunks: string[] = [];

    for (const rawItem of items) {
      const item = asObject(rawItem);
      if (item.type === "agentMessage") {
        const text = coerceString(item.text);
        if (text) {
          chunks.push(text);
        }
      }
    }

    if (chunks.length > 0) {
      return chunks.join("\n\n").trim();
    }

    if (turn.status === "failed") {
      return coerceString(asObject(turn.error).message) ?? "Turn failed without a message.";
    }

    if (turn.status === "interrupted") {
      return "Turn interrupted.";
    }

    return "";
  }

  private extractFilesChanged(turn: TurnReadRecord): string[] {
    const items = Array.isArray(turn.items) ? turn.items : [];
    const files = new Set<string>();

    for (const rawItem of items) {
      const item = asObject(rawItem);
      if (item.type !== "fileChange") {
        continue;
      }

      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const rawChange of changes) {
        const change = asObject(rawChange);
        const path = coerceString(change.path);
        if (path) {
          files.add(path);
        }
      }
    }

    return [...files];
  }

  private toApprovalRequest(method: string, params: Record<string, unknown>, requestId: string): ApprovalRequest {
    const threadId = coerceString(params.threadId) ?? "";
    const reason = coerceString(params.reason);

    switch (method) {
      case "item/commandExecution/requestApproval":
        return {
          id: requestId,
          type: "command",
          description: reason ?? coerceString(params.command) ?? "Codex requested command execution approval",
          context: {
            backendApprovalId: requestId,
            threadId,
            requestMethod: method,
            ...params,
          },
        };
      case "item/fileChange/requestApproval":
        return {
          id: requestId,
          type: "file-change",
          description: reason ?? "Codex requested file change approval",
          context: {
            backendApprovalId: requestId,
            threadId,
            requestMethod: method,
            ...params,
          },
        };
      case "item/permissions/requestApproval": {
        const permissions = asObject(params.permissions);
        const network = asObject(permissions.network);
        const fileSystem = asObject(permissions.fileSystem);
        const permissionType =
          network.enabled !== undefined
            ? "network"
            : Array.isArray(fileSystem.write) || Array.isArray(fileSystem.read)
              ? "file-change"
              : "connector";

        return {
          id: requestId,
          type: permissionType as ApprovalRequest["type"],
          description: reason ?? "Codex requested additional permissions",
          context: {
            backendApprovalId: requestId,
            threadId,
            requestMethod: method,
            ...params,
          },
        };
      }
      default:
        return {
          id: requestId,
          type: "connector",
          description: `${method} requires a client response`,
          context: {
            backendApprovalId: requestId,
            threadId,
            requestMethod: method,
            ...params,
          },
        };
    }
  }

  private toExecutionThread(thread: Record<string, unknown>): ExecutionThread {
    const id = coerceString(thread.id);
    const cwd = coerceString(thread.cwd);
    if (!id || !cwd) {
      throw new Error("Invalid thread payload returned by codex app-server");
    }

    return {
      id,
      backendThreadId: id,
      cwd,
      status: this.toExecutionStatus(asObject(thread.status)),
    };
  }

  private toExecutionStatus(status: Record<string, unknown>): ExecutionThread["status"] {
    const type = coerceString(status.type);
    if (type === "active") {
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      return flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")
        ? "waiting_approval"
        : "active";
    }
    return "idle";
  }

  private toTurnResultStatus(status: TurnReadRecord["status"]): TurnResult["status"] {
    switch (status) {
      case "completed":
        return "completed";
      case "interrupted":
        return "cancelled";
      case "failed":
        return "failed";
      default:
        return "failed";
    }
  }

  private toReviewTarget(target?: string): Record<string, unknown> {
    if (!target || target === "uncommitted") {
      return { type: "uncommittedChanges" };
    }
    if (target === "branch-diff") {
      return { type: "baseBranch", branch: "main" };
    }
    if (/^[a-f0-9]{7,40}$/i.test(target)) {
      return { type: "commit", sha: target, title: null };
    }
    return { type: "custom", instructions: target };
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private sendResponse(id: JsonRpcId, result: Record<string, unknown>): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private sendErrorResponse(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    });
  }

  private async sendRequest(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    await this.ensureProcessRunning();

    const id = ++this.requestCounter;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        resolve,
        reject,
        timeout,
      });
    });

    this.writeMessage(request);
    return promise;
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.process?.stdin.writable) {
      throw new Error("Codex App Server stdin is not available");
    }

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async ensureProcessRunning(): Promise<void> {
    if (this.stateDbHealing) {
      try {
        await this.stateDbHealing;
      } catch {
        // heal errors are already logged; we still try to start fresh
      }
    }

    if (!this.process || this.process.killed) {
      this.startProcess();
      this.initialized = false;
      await this.performInitializeHandshake();
    }
  }

  private async ensureThreadAvailable(threadId: string): Promise<void> {
    await this.ensureInitialized();
    if (!this.threads.has(threadId)) {
      const resumed = await this.resumeThread(threadId);
      if (!resumed) {
        throw new Error(`Codex thread is unavailable: ${threadId}`);
      }
    }
  }

  private handleTransportFailure(error: Error): void {
    if (this.shuttingDown) {
      this.process = null;
      return;
    }

    if (!this.process && !this.initialized) {
      return;
    }

    log.error({ err: error }, "Codex App Server transport failed");

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const turn of this.pendingTurns.values()) {
      turn.reject(error);
    }
    this.pendingTurns.clear();

    this.process = null;
    this.initialized = false;
  }

  private async performInitializeHandshake(): Promise<void> {
    await this.sendRequest("initialize", {
      protocolVersion: "0.1.0",
      clientInfo: {
        name: "maverick",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: this.options.persistExtendedHistory || this.options.experimentalRawEvents,
      },
    });

    this.sendNotification("initialized", {});
    await this.sendRequest("thread/list", {});

    this.initialized = true;
    log.info("Codex App Server adapter initialized");
  }
}
