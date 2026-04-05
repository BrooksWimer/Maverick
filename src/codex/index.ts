export type {
  ExecutionBackendAdapter,
  ExecutionThread,
  TurnRequest,
  TurnResult,
  SteerRequest,
  ReviewRequest,
  ReviewResult,
  ApprovalRequest,
} from "./types.js";

export { CodexCliAdapter } from "./cli-adapter.js";
export { CodexAppServerAdapter } from "./app-server-adapter.js";
export { MockAdapter } from "./mock-adapter.js";

import type { ExecutionBackend } from "../config/schema.js";
import type { ExecutionBackendAdapter } from "./types.js";
import { CodexAppServerAdapter } from "./app-server-adapter.js";
import { CodexCliAdapter } from "./cli-adapter.js";
import { MockAdapter } from "./mock-adapter.js";

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
    case "codex-cli":
      return new CodexCliAdapter({
        model: config.model,
        approvalMode: config.approvalMode,
      });
    case "mock":
      return new MockAdapter({ responseDelay: config.responseDelay });
    default:
      throw new Error(`Unknown execution backend type: ${(config as { type: string }).type}`);
  }
}
