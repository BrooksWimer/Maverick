/**
 * Mock adapter for testing the orchestrator without Codex installed.
 * Simulates execution with configurable delays and canned responses.
 */
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

const log = createLogger("mock-adapter");

export class MockAdapter implements ExecutionBackendAdapter {
  readonly name = "mock";
  private responseDelay: number;
  private threads: Map<string, ExecutionThread> = new Map();
  private outputCallbacks: Array<(threadId: string, content: string, isPartial: boolean) => void> = [];
  private approvalCallbacks: Array<(threadId: string, request: ApprovalRequest) => void> = [];

  constructor(options: { responseDelay?: number } = {}) {
    this.responseDelay = options.responseDelay ?? 1000;
  }

  async initialize(): Promise<void> {
    log.info("Mock adapter initialized");
  }

  async shutdown(): Promise<void> {
    this.threads.clear();
    log.info("Mock adapter shut down");
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread: ExecutionThread = {
      id: randomUUID(),
      backendThreadId: `mock-${randomUUID().slice(0, 8)}`,
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
    if (!thread) throw new Error(`Unknown thread: ${request.threadId}`);

    thread.status = "active";
    log.info({ threadId: request.threadId, instruction: request.instruction.slice(0, 80) }, "Mock turn started");

    // Simulate streaming output
    const phases = [
      `[Mock] Analyzing: "${request.instruction.slice(0, 60)}..."`,
      `[Mock] Working in ${request.cwd}...`,
      `[Mock] Generating changes...`,
      `[Mock] Turn completed successfully.`,
    ];

    for (const phase of phases) {
      await this.delay(this.responseDelay / phases.length);
      for (const cb of this.outputCallbacks) {
        cb(request.threadId, phase + "\n", true);
      }
    }

    thread.status = "idle";
    const output = phases.join("\n");

    return {
      backendTurnId: `mock-turn-${randomUUID().slice(0, 8)}`,
      status: "completed",
      output,
      summary: `Mock execution of: ${request.instruction.slice(0, 100)}`,
      filesChanged: [],
    };
  }

  async steerTurn(request: SteerRequest): Promise<void> {
    log.info({ threadId: request.threadId, steer: request.instruction.slice(0, 80) }, "Mock steer");
  }

  async interruptTurn(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) thread.status = "idle";
    log.info({ threadId }, "Mock turn interrupted");
  }

  async resolveApproval(threadId: string, approvalId: string, approved: boolean): Promise<void> {
    log.info({ threadId, approvalId, approved }, "Mock approval resolved");
  }

  async startReview(_request: ReviewRequest): Promise<ReviewResult> {
    await this.delay(this.responseDelay);
    return {
      findings: "[Mock] No issues found. Code looks clean.",
      severity: "clean",
      suggestions: ["Consider adding more tests."],
    };
  }

  onOutput(callback: (threadId: string, content: string, isPartial: boolean) => void): void {
    this.outputCallbacks.push(callback);
  }

  onApprovalRequest(callback: (threadId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(callback);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
