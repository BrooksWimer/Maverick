import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger } from "../logger.js";
import type {
  ApprovalRequest,
  ExecutionBackendAdapter,
  ExecutionThread,
  ReviewRequest,
  ReviewResult,
  SteerRequest,
  TurnRequest,
  TurnResult,
} from "../codex/types.js";
import type { ClaudePermissionMode } from "./types.js";

const log = createLogger("claude-cli");

type ClaudeCliOptions = {
  model?: string;
  claudePath?: string;
  permissionMode?: ClaudePermissionMode;
  maxTurns?: number;
};

type ClaudeTurnOptions = {
  addDirs: string[];
  model: string;
  permissionMode: string;
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown> | string;
  maxBudgetUsd?: number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  noSessionPersistence?: boolean;
};

export interface ParsedClaudeStreamEvent {
  kind: "delta" | "final" | "error" | "unknown";
  text?: string;
  message?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractText(entry));
  }

  if (!isObject(value)) {
    return [];
  }

  const directText = typeof value.text === "string" ? [value.text] : [];
  return [
    ...directText,
    ...extractText(value.delta),
    ...extractText(value.message),
    ...extractText(value.result),
    ...extractText(value.content),
  ];
}

export function parseClaudeStreamLine(line: string): ParsedClaudeStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "unknown" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "delta", text: trimmed };
  }

  if (!isObject(parsed)) {
    return { kind: "unknown" };
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const text = extractText(parsed).join("");

  if (type === "error") {
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : isObject(parsed.error) && typeof parsed.error.message === "string"
          ? parsed.error.message
          : "Claude CLI reported an error.";
    return { kind: "error", message };
  }

  if (type.includes("delta")) {
    return { kind: "delta", text };
  }

  if (type.includes("result") || type.includes("final") || type === "message" || type === "message_stop") {
    return { kind: "final", text };
  }

  return text ? { kind: "delta", text } : { kind: "unknown" };
}

function summarizeOutput(output: string): string {
  const normalized = output.trim();
  if (normalized.length <= 500) {
    return normalized;
  }

  return `${normalized.slice(0, 497)}...`;
}

function normalizeSeverity(value: unknown): ReviewResult["severity"] {
  return value === "clean" || value === "minor" || value === "major" || value === "critical"
    ? value
    : "minor";
}

function pushToolList(args: string[], flag: string, values?: string[]): void {
  const cleaned = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (cleaned.length > 0) {
    args.push(flag, cleaned.join(","));
  }
}

export function buildClaudePrintArgs(options: ClaudeTurnOptions): string[] {
  const args = [
    "-p",
    "--verbose",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--model",
    options.model,
  ];

  if (options.permissionMode !== "default") {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  if (options.noSessionPersistence) {
    args.push("--no-session-persistence");
  }

  if (typeof options.maxBudgetUsd === "number" && Number.isFinite(options.maxBudgetUsd) && options.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  if (options.jsonSchema) {
    args.push(
      "--json-schema",
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema),
    );
  }

  pushToolList(args, "--tools", options.tools);
  pushToolList(args, "--allowedTools", options.allowedTools);
  pushToolList(args, "--disallowedTools", options.disallowedTools);

  for (const addDir of options.addDirs) {
    args.push("--add-dir", addDir);
  }

  return args;
}

function resolveDefaultClaudePath(explicitPath?: string): string {
  if (explicitPath?.trim()) {
    return explicitPath.trim();
  }

  if (process.env.CLAUDE_PATH?.trim()) {
    return process.env.CLAUDE_PATH.trim();
  }

  if (process.platform === "win32") {
    const candidates = [
      process.env.USERPROFILE ? join(process.env.USERPROFILE, ".local", "bin", "claude.exe") : null,
      process.env.APPDATA ? join(process.env.APPDATA, "npm", "claude.cmd") : null,
      "claude.cmd",
      "claude",
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      if (!candidate.includes("\\") && !candidate.includes("/")) {
        return candidate;
      }

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "claude";
}

function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function formatProcessError(error: unknown, attemptedPath: string): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return [
      `Claude CLI executable was not found at "${attemptedPath}".`,
      "Install Claude Code or set CLAUDE_PATH to the full executable path.",
    ].join(" ");
  }

  return error instanceof Error ? error.message : String(error);
}

export function parseStructuredReviewOutput(output: string): ReviewResult {
  const trimmed = output.trim();
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  const candidate = codeFenceMatch ? codeFenceMatch[1] : trimmed;

  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((value): value is string => typeof value === "string")
      : [];
    return {
      severity: normalizeSeverity(parsed.severity),
      findings: typeof parsed.findings === "string" ? parsed.findings : trimmed,
      suggestions,
    };
  } catch {
    return {
      severity: "minor",
      findings: trimmed,
      suggestions: [],
    };
  }
}

export class ClaudeCliAdapter implements ExecutionBackendAdapter {
  readonly name = "claude-code";

  private readonly options: Required<Pick<ClaudeCliOptions, "model" | "claudePath" | "permissionMode" | "maxTurns">>;
  private readonly outputCallbacks: Array<(threadId: string, content: string, isPartial: boolean) => void> = [];
  private readonly approvalCallbacks: Array<(threadId: string, request: ApprovalRequest) => void> = [];
  private readonly threads = new Map<string, ExecutionThread>();
  private readonly activeProcesses = new Map<string, ReturnType<typeof spawn>>();

  constructor(options: ClaudeCliOptions = {}) {
    this.options = {
      model: options.model ?? "sonnet",
      claudePath: resolveDefaultClaudePath(options.claudePath),
      permissionMode: options.permissionMode ?? "plan",
      maxTurns: options.maxTurns ?? 10,
    };
  }

  async initialize(): Promise<void> {
    await this.exec([this.options.claudePath, "--version"]);
    log.info("Claude CLI adapter initialized");
  }

  async shutdown(): Promise<void> {
    for (const process of this.activeProcesses.values()) {
      process.kill("SIGTERM");
    }
    this.activeProcesses.clear();
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread: ExecutionThread = {
      id: randomUUID(),
      cwd,
      status: "idle",
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    const thread = this.threads.get(request.threadId);
    if (!thread) {
      throw new Error(`Unknown Claude thread: ${request.threadId}`);
    }

    thread.status = "active";

    const permissionMode = request.permissionMode ?? this.options.permissionMode;
    const model = request.model ?? this.options.model;

    try {
      const result = await this.runClaudeTurn(request.threadId, request.cwd, request.instruction, {
        addDirs: request.addDirs ?? [],
        model,
        permissionMode,
        systemPrompt: request.systemPrompt,
        jsonSchema: request.jsonSchema,
        maxBudgetUsd: request.maxBudgetUsd,
        tools: request.tools,
        allowedTools: request.allowedTools,
        disallowedTools: request.disallowedTools,
        noSessionPersistence: request.noSessionPersistence,
      });

      thread.status = "idle";
      return result;
    } catch (error) {
      thread.status = "idle";
      const message = formatProcessError(error, this.options.claudePath);
      log.error({ err: error, threadId: request.threadId }, "Claude turn failed");
      return {
        status: "failed",
        output: message,
        summary: message,
      };
    }
  }

  async steerTurn(_request: SteerRequest): Promise<void> {
    log.warn("Claude CLI headless mode does not support mid-turn steering.");
  }

  async interruptTurn(threadId: string): Promise<void> {
    const process = this.activeProcesses.get(threadId);
    if (process) {
      process.kill("SIGTERM");
      this.activeProcesses.delete(threadId);
    }
  }

  async resolveApproval(_threadId: string, _approvalId: string, _approved: boolean): Promise<void> {
    log.warn("Claude CLI headless mode is configured for non-interactive tasks only.");
  }

  async startReview(request: ReviewRequest): Promise<ReviewResult> {
    const reviewPrompt =
      request.instruction ??
      [
        "Review the supplied implementation for correctness, risk, and missing tests.",
        request.context ? request.context : null,
        request.target ? `Target: ${request.target}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

    const result = await this.startTurn({
      threadId: request.threadId,
      cwd: request.cwd,
      instruction: reviewPrompt,
      model: request.model,
      systemPrompt:
        request.systemPrompt ??
        "You are reviewing another agent's work. Be concrete about bugs, regressions, and missing validation.",
        addDirs: request.addDirs,
        maxTurns: request.maxTurns ?? 3,
        permissionMode: request.permissionMode ?? "plan",
        jsonSchema: request.jsonSchema,
        maxBudgetUsd: request.maxBudgetUsd,
        tools: request.tools,
        allowedTools: request.allowedTools,
        disallowedTools: request.disallowedTools,
        noSessionPersistence: request.noSessionPersistence,
      });

    if (result.status !== "completed") {
      return {
        findings: result.output,
        severity: "major",
        suggestions: [],
      };
    }

    return parseStructuredReviewOutput(result.output);
  }

  onOutput(callback: (threadId: string, content: string, isPartial: boolean) => void): void {
    this.outputCallbacks.push(callback);
  }

  onApprovalRequest(callback: (threadId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(callback);
  }

  private async runClaudeTurn(
    threadId: string,
    cwd: string,
    instruction: string,
    options: {
      addDirs: string[];
      model: string;
      permissionMode: string;
      systemPrompt?: string;
      jsonSchema?: Record<string, unknown> | string;
      maxBudgetUsd?: number;
      tools?: string[];
      allowedTools?: string[];
      disallowedTools?: string[];
      noSessionPersistence?: boolean;
    }
  ): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      const args = buildClaudePrintArgs(options);

      const child = spawn(this.options.claudePath, args, {
        cwd,
        env: { ...process.env },
        shell: needsShell(this.options.claudePath),
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeProcesses.set(threadId, child);

      const stdout = createInterface({ input: child.stdout });
      const stderr = createInterface({ input: child.stderr });
      const partialOutput: string[] = [];
      let finalOutput = "";
      const stderrLines: string[] = [];

      stdout.on("line", (line) => {
        const event = parseClaudeStreamLine(line);
        if (event.kind === "error") {
          stderrLines.push(event.message ?? "Claude CLI reported an error.");
          return;
        }

        if (event.kind === "delta" && event.text) {
          partialOutput.push(event.text);
          for (const callback of this.outputCallbacks) {
            callback(threadId, event.text, true);
          }
          return;
        }

        if (event.kind === "final" && event.text) {
          finalOutput = event.text;
        }
      });

      stderr.on("line", (line) => {
        stderrLines.push(line);
      });

      child.stdin.end(instruction);

      child.on("close", (code) => {
        this.activeProcesses.delete(threadId);
        stdout.close();
        stderr.close();

        const output = (finalOutput || partialOutput.join("")).trim();
        if (code === 0) {
          for (const callback of this.outputCallbacks) {
            callback(threadId, output, false);
          }

          resolve({
            backendTurnId: randomUUID(),
            status: "completed",
            output,
            summary: summarizeOutput(output),
          });
          return;
        }

        reject(new Error(`Claude exited with code ${code}: ${(stderrLines.join("\n") || output).trim()}`));
      });

      child.on("error", (error) => {
        this.activeProcesses.delete(threadId);
        stdout.close();
        stderr.close();
        reject(new Error(formatProcessError(error, this.options.claudePath)));
      });
    });
  }

  private async exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), {
        cwd: process.cwd(),
        env: { ...process.env },
        shell: needsShell(args[0]),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || `Command exited with ${code}`));
      });

      child.on("error", (error) => {
        reject(new Error(formatProcessError(error, args[0])));
      });
    });
  }
}
