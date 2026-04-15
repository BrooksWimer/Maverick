import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVerificationContextRecord } from "../../src/agents/verification-support.js";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import type {
  ApprovalRequest,
  ExecutionBackendAdapter,
  ExecutionThread,
  ReviewRequest,
  ReviewResult,
  SteerRequest,
  TurnRequest,
  TurnResult,
} from "../../src/codex/index.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import { closeDatabase, initDatabase } from "../../src/state/index.js";

class QueuedAdapter implements ExecutionBackendAdapter {
  readonly turnRequests: TurnRequest[] = [];
  private readonly threads = new Map<string, ExecutionThread>();
  private nextThreadId = 1;

  constructor(
    readonly name: string,
    private readonly turnResults: TurnResult[],
  ) {}

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.threads.clear();
  }

  async createThread(cwd: string): Promise<ExecutionThread> {
    const thread = {
      id: `${this.name}-thread-${this.nextThreadId++}`,
      cwd,
      status: "idle" as const,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async resumeThread(threadId: string): Promise<ExecutionThread | null> {
    return this.threads.get(threadId) ?? null;
  }

  async startTurn(request: TurnRequest): Promise<TurnResult> {
    this.turnRequests.push(request);
    const result = this.turnResults.shift();
    if (!result) {
      throw new Error(`No queued turn result for ${this.name}`);
    }
    return result;
  }

  async steerTurn(_request: SteerRequest): Promise<void> {}

  async interruptTurn(_threadId: string): Promise<void> {}

  async resolveApproval(_threadId: string, _approvalId: string, _approved: boolean): Promise<void> {}

  async startReview(_request: ReviewRequest): Promise<ReviewResult> {
    return {
      findings: "clean",
      severity: "clean",
      suggestions: [],
    };
  }

  onOutput(_callback: (threadId: string, content: string, isPartial: boolean) => void): void {}

  onApprovalRequest(_callback: (threadId: string, request: ApprovalRequest) => void): void {}
}

function agentOutput(payload: Record<string, unknown>, summary: string): TurnResult {
  return {
    backendTurnId: "agent-turn",
    status: "completed",
    output: `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${summary}`,
    summary,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for asynchronous orchestration work.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Orchestrator verification agent routing", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-verification-agent-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");

    initDatabase(join(tempDir, "orchestrator.db"));

    config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: {
          type: "mock",
          responseDelay: 0,
        },
      },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
          claudeVerification: {
            enabled: true,
            autoAfterTurn: true,
            model: "sonnet",
          },
          claudeReview: {
            enabled: true,
            autoAfterTurn: true,
            model: "sonnet",
          },
        },
      ],
    });
  });

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("stores structured verification context and feeds it into Claude review", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      agentOutput(
        {
          status: "pass",
          checks: [
            {
              name: "Tests",
              command: "npm test",
              status: "pass",
              output: "ok",
              duration_ms: 100,
            },
          ],
          preExistingFailures: [],
          introducedFailures: [],
          recommendation: "ready-for-review",
          fixTargets: [],
        },
        "Verification complete.",
      ),
      agentOutput(
        {
          verdict: "ship",
          severity: "clean",
          passes: [{ name: "Correctness", status: "clean", findingCount: 0 }],
          securityFindings: [],
          architectureFindings: [],
          correctnessFindings: [],
          conventionFindings: [],
          suggestions: [],
        },
        "Review complete.",
      ),
    ]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "manual verification",
    });
    await orchestrator.transitionState(workstream.id, "scope-defined");
    await orchestrator.transitionState(workstream.id, "plan-approved");

    const verification = await orchestrator.verify(workstream.id, {
      trigger: "manual",
    });

    expect(verification.verificationContext.result.status).toBe("pass");
    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("review");
    expect(parseVerificationContextRecord(orchestrator.getWorkstream(workstream.id)?.verification_context_json ?? null)?.result.status).toBe("pass");

    await orchestrator.review(workstream.id, "uncommitted", {
      reviewer: "claude",
      trigger: "manual",
    });

    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Verify the current workstream changes");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Relevant Test Results");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("## Verification Passed");
  });

  it("auto-runs verification and auto-review after a successful Codex turn", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      agentOutput(
        {
          status: "pass",
          checks: [
            {
              name: "Tests",
              command: "npm test",
              status: "pass",
              output: "ok",
              duration_ms: 100,
            },
          ],
          preExistingFailures: [],
          introducedFailures: [],
          recommendation: "ready-for-review",
          fixTargets: [],
        },
        "Verification complete.",
      ),
      agentOutput(
        {
          verdict: "ship",
          severity: "clean",
          passes: [{ name: "Correctness", status: "clean", findingCount: 0 }],
          securityFindings: [],
          architectureFindings: [],
          correctnessFindings: [],
          conventionFindings: [],
          suggestions: [],
        },
        "Review complete.",
      ),
    ]);
    const dispatchAdapter = new QueuedAdapter("codex-app-server", [
      {
        backendTurnId: "dispatch-turn",
        status: "completed",
        output: "implemented",
        summary: "implemented",
      },
    ]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;
    (orchestrator as { adapters: Map<string, ExecutionBackendAdapter> }).adapters.set("maverick", dispatchAdapter);

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "auto verification pass",
    });
    await orchestrator.transitionState(workstream.id, "scope-defined");

    await orchestrator.dispatch(workstream.id, "Implement the verification loop.");
    await waitFor(() => utilityAdapter.turnRequests.length === 2);

    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("review");
    expect(utilityAdapter.turnRequests[0]?.instruction).toContain("Verify the current workstream changes");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Relevant Test Results");
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("## Verification Passed");
  });

  it("falls back to implementation without starting review when auto verification fails", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();

    const utilityAdapter = new QueuedAdapter("utility", [
      agentOutput(
        {
          status: "fail",
          checks: [
            {
              name: "Tests",
              command: "npm test",
              status: "fail",
              output: "boom",
              duration_ms: 100,
            },
          ],
          preExistingFailures: [],
          introducedFailures: ["tests/auth.test.ts fails"],
          recommendation: "needs-fixes",
          fixTargets: ["tests/auth.test.ts"],
        },
        "Verification failed.",
      ),
      agentOutput(
        {
          severity: "medium",
          rootCause: "The verification diff command assumes a git baseline that is missing in this worktree.",
          correlatedChanges: ["src/orchestrator/orchestrator.ts"],
          suggestedFix: "Use the current worktree diff and avoid assuming main exists before comparing verification output.",
          affectedWorkstreams: ["auto verification fail"],
          escalationNeeded: false,
        },
        "Incident triage complete.",
      ),
    ]);
    const dispatchAdapter = new QueuedAdapter("codex-app-server", [
      {
        backendTurnId: "dispatch-turn",
        status: "completed",
        output: "implemented",
        summary: "implemented",
      },
    ]);
    (orchestrator as { utilityClaudeAdapter: ExecutionBackendAdapter | null }).utilityClaudeAdapter = utilityAdapter;
    (orchestrator as { adapters: Map<string, ExecutionBackendAdapter> }).adapters.set("maverick", dispatchAdapter);

    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "auto verification fail",
    });
    await orchestrator.transitionState(workstream.id, "scope-defined");

    await orchestrator.dispatch(workstream.id, "Implement the verification loop.");
    await waitFor(() => {
      const context = parseVerificationContextRecord(orchestrator?.getWorkstream(workstream.id)?.verification_context_json ?? null);
      return Boolean(context?.incidentTriage);
    });

    expect(orchestrator.getWorkstream(workstream.id)?.state).toBe("implementation");
    expect(utilityAdapter.turnRequests).toHaveLength(2);
    expect(utilityAdapter.turnRequests[1]?.instruction).toContain("Diagnose the introduced verification failures");
    expect(parseVerificationContextRecord(orchestrator.getWorkstream(workstream.id)?.verification_context_json ?? null)?.result.status).toBe("fail");
    expect(parseVerificationContextRecord(orchestrator.getWorkstream(workstream.id)?.verification_context_json ?? null)?.incidentTriage?.suggestedFix).toContain("current worktree diff");
    expect(orchestrator.getWorkstream(workstream.id)?.current_goal).toContain("Primary fix");
  });
});
