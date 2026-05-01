export type {
  ExecutionBackendAdapter,
  ExecutionInputItem,
  ExecutionThread,
  TurnRequest,
  TurnResult,
  SteerRequest,
  ReviewRequest,
  ReviewResult,
  ApprovalRequest,
} from "./types.js";

export { CodexAppServerAdapter } from "./app-server-adapter.js";
export { MockAdapter } from "./mock-adapter.js";
export { ClaudeCliAdapter } from "../claude/claude-adapter.js";

import type { ExecutionBackend } from "../config/schema.js";
import type { ExecutionBackendAdapter } from "./types.js";
import { CodexAppServerAdapter } from "./app-server-adapter.js";
import { MockAdapter } from "./mock-adapter.js";
import { ClaudeCliAdapter } from "../claude/claude-adapter.js";

/**
 * Factory: create the right adapter based on config.
 */
export function createAdapter(config: ExecutionBackend): ExecutionBackendAdapter {
  switch (config.type) {
    case "codex-app-server":
      return new CodexAppServerAdapter({
        transport: config.transport,
        model: config.model,
        sandboxMode: config.sandboxMode,
        approvalPolicy: config.approvalPolicy,
        nodePath: config.nodePath,
        codexJsPath: config.codexJsPath,
        websocketPort: config.websocketPort,
        persistExtendedHistory: config.persistExtendedHistory,
        experimentalRawEvents: config.experimentalRawEvents,
      });
    case "claude-code":
      return new ClaudeCliAdapter({
        model: config.model,
        claudePath: config.claudePath,
        permissionMode: config.permissionMode,
        maxTurns: config.maxTurns,
      });
    case "mock":
      return new MockAdapter({ responseDelay: config.responseDelay });
    default:
      throw new Error(`Unknown execution backend type: ${(config as { type: string }).type}`);
  }
}
