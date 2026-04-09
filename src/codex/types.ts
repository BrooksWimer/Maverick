/**
 * Execution backend abstraction.
 *
 * This interface decouples the orchestrator from any specific Codex transport.
 * You can start with CodexCliAdapter (subprocess-based, works today),
 * then upgrade to CodexAppServerAdapter (JSON-RPC, full features) when ready.
 *
 * A MockAdapter is also provided for testing without Codex installed.
 */

export interface ExecutionThread {
  id: string;
  backendThreadId?: string;  // The ID used by the underlying backend (e.g., Codex thread ID)
  cwd: string;
  status: "active" | "idle" | "waiting_approval" | "archived";
}

export type ExecutionInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      imageUrl: string;
    }
  | {
      type: "local_image";
      path: string;
    };

export interface TurnRequest {
  threadId: string;
  instruction: string;
  cwd: string;
  model?: string;
  approvalMode?: string;
  inputItems?: ExecutionInputItem[];
  systemPrompt?: string;
  addDirs?: string[];
  maxTurns?: number;
  permissionMode?: string;
}

export interface TurnResult {
  backendTurnId?: string;
  status: "completed" | "failed" | "cancelled" | "needs_approval";
  output: string;
  summary?: string;
  filesChanged?: string[];
  approvalRequest?: ApprovalRequest;
}

export interface ApprovalRequest {
  id: string;
  type: "command" | "file-change" | "network" | "connector" | "user-input";
  description: string;
  context: Record<string, unknown>;
}

export interface SteerRequest {
  threadId: string;
  instruction: string;
}

export interface ReviewRequest {
  threadId: string;
  cwd: string;
  target?: "uncommitted" | "branch-diff" | string;  // commit SHA or branch name
  instruction?: string;
  context?: string;
  model?: string;
  systemPrompt?: string;
  addDirs?: string[];
  maxTurns?: number;
  permissionMode?: string;
}

export interface ReviewResult {
  findings: string;
  severity: "clean" | "minor" | "major" | "critical";
  suggestions?: string[];
}

/**
 * The execution backend interface.
 * Every backend (CLI, App Server, Mock) must implement this.
 */
export interface ExecutionBackendAdapter {
  readonly name: string;

  /** Initialize the backend connection/process */
  initialize(): Promise<void>;

  /** Shut down cleanly */
  shutdown(): Promise<void>;

  /** Start a new execution thread in a working directory */
  createThread(cwd: string): Promise<ExecutionThread>;

  /** Resume an existing thread */
  resumeThread(threadId: string): Promise<ExecutionThread | null>;

  /** Start a turn (unit of work) in a thread */
  startTurn(request: TurnRequest): Promise<TurnResult>;

  /** Steer an in-flight turn with additional instructions */
  steerTurn(request: SteerRequest): Promise<void>;

  /** Interrupt/cancel an in-flight turn */
  interruptTurn(threadId: string): Promise<void>;

  /** Respond to an approval request */
  resolveApproval(threadId: string, approvalId: string, approved: boolean): Promise<void>;

  /** Run a structured review */
  startReview(request: ReviewRequest): Promise<ReviewResult>;

  /**
   * Register a callback for streaming output from turns.
   * The backend calls this as work progresses.
   */
  onOutput(callback: (threadId: string, content: string, isPartial: boolean) => void): void;

  /**
   * Register a callback for approval requests from the backend.
   */
  onApprovalRequest(callback: (threadId: string, request: ApprovalRequest) => void): void;
}
