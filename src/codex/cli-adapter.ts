/**
 * Codex CLI adapter: runs codex as a subprocess.
 *
 * This is the "works today" backend. It shells out to `codex` CLI for each turn,
 * captures output, and handles the basic execution flow.
 *
 * Limitations vs. App Server:
 * - No streaming (output comes back after completion)
 * - No mid-turn steering
 * - No interactive approval flow (uses --approval-mode flag)
 * - No persistent threads (each invocation is independent)
 *
 * But it's sufficient for validating the orchestration logic and getting
 * real work done while you set up App Server.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import type {
  ExecutionBackendAdapter,
  ExecutionThread,
  TurnRequest,
  TurnResult,
  SteerRequest,
  ReviewRequest,
  ReviewResult,
  ApprovalRequest,
} from "./types.js";

const log = createLogger("codex-cli");

interface CliOptions {
  model?: string;
  approvalMode?: string;
  codexPath?: string;  // path to codex binary, defaults to 'codex'
}

export class CodexCliAdapter implements ExecutionBackendAdapter {
  readonly name = "codex-cli";
  private options: CliOptions;
  private outputCallbacks: Array<(threadId: string, content: string, isPartial: boolean) => void> = [];
  private approvalCallbacks: Array<(threadId: string, request: ApprovalRequest) => void> = [];
  private activeProcesses: Map<string, ReturnType<typeof spawn>> = new Map();
  // Track thread metadata for resumption context
  private threads: Map<string, ExecutionThread> = new Map();

  constructor(options: CliOptions = {}) {
    this.options = {
      model: options.model ?? "o4-mini",
      approvalMode: options.approvalMode ?? "auto-edit",
      codexPath: options.codexPath ?? "codex",
    };
  }

  async initialize(): Promise<void> {
    // Verify codex is available
    try {
      await this.exec([this.options.codexPath!, "--version"]);
      log.info("Codex CLI adapter initialized");
    } catch (err) {
      log.error({ err }, "Codex CLI not found. Install with: npm install -g @openai/codex");
      throw new Error("Codex CLI not available");
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, proc] of this.activeProcesses) {
      log.info({ threadId: id }, "Killing active process");
      proc.kill("SIGTERM");
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
    log.info({ threadId: thread.id, cwd }, "Thread created");
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    // CLI adapter doesn't have persistent threads, but we track metadata
    return this.threads.get(threadId) ?? null;
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    const thread = this.threads.get(request.threadId);
    if (!thread) {
      throw new Error(`Unknown thread: ${request.threadId}`);
    }

    thread.status = "active";
    const model = request.model ?? this.options.model!;
    const approvalMode = request.approvalMode ?? this.options.approvalMode!;

    const args = [
      this.options.codexPath!,
      "--model", model,
      "--approval-mode", approvalMode,
      "--quiet",
      request.instruction,
    ];

    log.info({ threadId: request.threadId, instruction: request.instruction.slice(0, 100) }, "Starting turn");

    try {
      const output = await this.execInDir(args, request.cwd, request.threadId);

      thread.status = "idle";
      const turnId = randomUUID();

      // Notify output listeners with the complete output
      for (const cb of this.outputCallbacks) {
        cb(request.threadId, output, false);
      }

      return {
        backendTurnId: turnId,
        status: "completed",
        output,
        summary: output.slice(0, 500),
      };
    } catch (err: unknown) {
      thread.status = "idle";
      const message = err instanceof Error ? err.message : String(err);
      log.error({ threadId: request.threadId, err: message }, "Turn failed");
      return {
        status: "failed",
        output: message,
      };
    }
  }

  async steerTurn(_request: SteerRequest): Promise<void> {
    log.warn("Steering not supported in CLI adapter. Use App Server adapter for mid-turn steering.");
  }

  async interruptTurn(threadId: string): Promise<void> {
    const proc = this.activeProcesses.get(threadId);
    if (proc) {
      proc.kill("SIGTERM");
      this.activeProcesses.delete(threadId);
      log.info({ threadId }, "Turn interrupted");
    }
  }

  async resolveApproval(_threadId: string, _approvalId: string, _approved: boolean): Promise<void> {
    log.warn("Interactive approvals not supported in CLI adapter. Use --approval-mode flag instead.");
  }

  async startReview(request: ReviewRequest): Promise<ReviewResult> {
    // Use codex to run a review-style prompt
    const reviewPrompt = `Review the code changes in this repository. Focus on correctness, security, and test coverage. ${
      request.target === "uncommitted" ? "Review uncommitted changes." :
      request.target === "branch-diff" ? "Review the branch diff against main." :
      request.target ? `Review commit ${request.target}.` : "Review recent changes."
    } Provide a structured summary with severity (clean/minor/major/critical) and specific suggestions.`;

    const result = await this.startTurn({
      threadId: request.threadId ?? "review-" + randomUUID(),
      instruction: reviewPrompt,
      cwd: request.cwd,
    });

    return {
      findings: result.output,
      severity: "minor", // Parse from output in a real implementation
      suggestions: [],
    };
  }

  onOutput(callback: (threadId: string, content: string, isPartial: boolean) => void): void {
    this.outputCallbacks.push(callback);
  }

  onApprovalRequest(callback: (threadId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(callback);
  }

  // --- Internal helpers ---

  private execInDir(args: string[], cwd: string, threadId?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(args[0], args.slice(1), {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (threadId) {
        this.activeProcesses.set(threadId, proc);
      }

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        // Emit partial output for streaming display
        if (threadId) {
          for (const cb of this.outputCallbacks) {
            cb(threadId, chunk, true);
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (threadId) {
          this.activeProcesses.delete(threadId);
        }
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Codex exited with code ${code}: ${stderr || stdout}`));
        }
      });

      proc.on("error", (err) => {
        if (threadId) {
          this.activeProcesses.delete(threadId);
        }
        reject(err);
      });
    });
  }

  private exec(args: string[]): Promise<string> {
    return this.execInDir(args, process.cwd());
  }
}
