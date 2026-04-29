/**
 * Agent runner — executes a Maverick custom agent via Claude CLI.
 *
 * Unlike the single-shot invocations in src/claude/claude-adapter.ts, the runner
 * assembles agent-specific context, injects tool definitions into the system
 * prompt, and parses structured output from the agent's response.
 *
 * Integration point: the orchestrator calls `runAgent()` at the appropriate
 * state machine transition. The runner builds the full prompt, spawns Claude
 * CLI with the agent's configuration, and returns a typed AgentResult.
 */

import { createLogger } from "../logger.js";
import type { ExecutionBackendAdapter } from "../codex/types.js";
import type {
  AgentContext,
  AgentDefinition,
  AgentId,
  AgentResult,
} from "./types.js";

// Agent registry — import each agent definition
import { intakeAgent } from "./intake-agent.js";
import { goalFramingAgent } from "./goal-framing-agent.js";
import { planningAgent } from "./planning-agent.js";
import { operatorFeedbackAgent } from "./operator-feedback-agent.js";
import { responseFormattingAgent } from "./response-formatting-agent.js";
import { modelingAgent } from "./modeling-agent.js";
import { testDesignAgent } from "./test-design-agent.js";
import { verificationAgent } from "./verification-agent.js";
import { reviewAgent } from "./review-agent.js";
import { epicContextAgent } from "./epic-context-agent.js";
import { mergeAgent } from "./merge-agent.js";
import { incidentTriageAgent } from "./incident-triage-agent.js";
import { briefAgent } from "./brief-agent.js";

const log = createLogger("agent-runner");

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

const AGENT_REGISTRY: Map<AgentId, AgentDefinition> = new Map([
  ["intake", intakeAgent],
  ["goal-framing", goalFramingAgent],
  ["planning", planningAgent],
  ["operator-feedback", operatorFeedbackAgent],
  ["response-formatting", responseFormattingAgent],
  ["modeling", modelingAgent],
  ["test-design", testDesignAgent],
  ["verification", verificationAgent],
  ["review", reviewAgent],
  ["epic-context", epicContextAgent],
  ["merge", mergeAgent],
  ["incident-triage", incidentTriageAgent],
  ["brief", briefAgent],
]);

export function getAgent(id: AgentId): AgentDefinition | undefined {
  return AGENT_REGISTRY.get(id);
}

export function listAgents(): AgentDefinition[] {
  return Array.from(AGENT_REGISTRY.values());
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildToolBlock(agent: AgentDefinition): string {
  if (agent.tools.length === 0) return "";

  const toolDescriptions = agent.tools
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([name, param]) => {
          const req = tool.required.includes(name) ? " (required)" : "";
          return `    - ${name}: ${param.type}${req} — ${param.description}`;
        })
        .join("\n");
      return `  **${tool.name}**: ${tool.description}\n${params}`;
    })
    .join("\n\n");

  return [
    "",
    "## Available Tools",
    "",
    "You have access to the following tools. Use them by calling the appropriate",
    "shell commands or file operations as described:",
    "",
    toolDescriptions,
    "",
  ].join("\n");
}

function buildContextBlock(context: AgentContext): string {
  const sections: string[] = [];

  sections.push(`## Context`);
  sections.push(`- **Project**: ${context.projectId}`);
  sections.push(`- **Canonical Repo Root**: ${context.canonicalRepoRoot ?? context.repoPath}`);
  sections.push(`- **Execution Workspace**: ${context.executionWorkspace ?? context.cwd}`);
  if (context.workspaceMode) {
    sections.push(`- **Workspace Mode**: ${context.workspaceMode}`);
  }
  if (context.durableBaseBranch) {
    sections.push(`- **Durable Base Branch**: ${context.durableBaseBranch}`);
  }
  if (context.disposableBranch) {
    sections.push(`- **Disposable Workstream Branch**: ${context.disposableBranch}`);
  }

  if (context.workstreamId) {
    sections.push(`- **Workstream**: ${context.workstreamName ?? context.workstreamId}`);
    sections.push(`- **State**: ${context.workstreamState ?? "unknown"}`);
  }

  if (context.epicCharter) {
    sections.push("");
    sections.push("## Epic Charter");
    sections.push(context.epicCharter);
  }

  if (context.agentsMd) {
    sections.push("");
    sections.push("## Project Doctrine (AGENTS.md)");
    sections.push(context.agentsMd);
  }

  for (const [key, value] of Object.entries(context.extra)) {
    sections.push("");
    sections.push(`## ${key}`);
    sections.push(value);
  }

  return sections.join("\n");
}

function assembleInstruction(
  agent: AgentDefinition,
  context: AgentContext,
): string {
  const parts: string[] = [];

  // Context block
  parts.push(buildContextBlock(context));

  // Tool block
  const toolBlock = buildToolBlock(agent);
  if (toolBlock) {
    parts.push(toolBlock);
  }

  // The actual instruction
  parts.push("");
  parts.push("## Instruction");
  parts.push(context.instruction);

  // Output format reminder
  if (agent.structuredOutput) {
    parts.push("");
    parts.push("## Output Format");
    if (agent.id === "planning") {
      parts.push(
        "Respond with only one JSON object that conforms to the structured output schema described in your system prompt. " +
        "Do not include prose before or after it, do not refer to content above, and do not write plan files.",
      );
    } else {
      parts.push(
        "Respond with a JSON object inside a ```json code fence. " +
        "The JSON must conform to the structured output schema described in your system prompt. " +
        "Include a brief natural-language summary AFTER the JSON block.",
      );
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Structured output parser
// ---------------------------------------------------------------------------

function parseStructuredOutput(
  output: string,
): Record<string, unknown> | null {
  const candidates = [
    output.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)?.[1],
    extractJsonObjectByKnownKeys(output),
    output.trim(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }

  log.warn("Failed to parse structured agent output");

  return null;
}

function extractJsonObjectByKnownKeys(output: string): string | null {
  const knownKeys = [
    '"currentStateSummary"',
    '"request"',
    '"systemSummary"',
    '"status"',
    '"verdict"',
    '"sections"',
  ];
  const keyIndex = knownKeys
    .map((key) => output.indexOf(key))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (keyIndex === undefined) {
    return null;
  }

  const startIndex = output.lastIndexOf("{", keyIndex);
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < output.length; index += 1) {
    const char = output[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return output.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function extractSummary(output: string, maxLength = 500): string {
  // If there's a JSON block, grab the text after it
  const afterJson = output.replace(/```(?:json)?\s*[\s\S]+?\s*```/i, "").trim();
  const summary = afterJson || output;

  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength - 3)}...`;
}

function extractSuggestedTrigger(
  agentId: AgentId,
  structured: Record<string, unknown> | null,
): string | undefined {
  if (!structured) return undefined;

  // Map agent outputs to state machine triggers
  switch (agentId) {
    case "intake": {
      const rec = structured.recommendation;
      if (rec === "proceed") return "scope-defined";
      if (rec === "needs-clarification") return "missing-info";
      return undefined;
    }
    case "verification": {
      const status = structured.status;
      if (status === "pass") return "verification-passed";
      if (status === "fail") return "verification-failed";
      return undefined;
    }
    case "review": {
      const verdict = structured.verdict;
      if (verdict === "ship" || verdict === "ship-with-caveats") return "review-approved";
      if (verdict === "needs-changes" || verdict === "reject") return "changes-requested";
      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Resume an existing thread when possible */
  threadId?: string;

  /** Override the agent's default permission mode */
  permissionMode?: "plan" | "auto" | "default";

  /** Override the agent's default max turns */
  maxTurns?: number;

  /** Override the model */
  model?: string;

  /** Claude CLI JSON schema guardrail */
  jsonSchema?: Record<string, unknown> | string;

  /** Claude CLI max budget guardrail */
  maxBudgetUsd?: number;

  /** Restrict available Claude tools */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];

  /** Disable Claude session persistence when safe for bounded utility runs */
  noSessionPersistence?: boolean;

  /** Callback for streaming output */
  onOutput?: (content: string, isPartial: boolean) => void;
}

export async function runAgent(
  adapter: ExecutionBackendAdapter,
  agentId: AgentId,
  context: AgentContext,
  options: RunAgentOptions = {},
): Promise<AgentResult> {
  const agent = AGENT_REGISTRY.get(agentId);
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }

  // Validate state applicability
  if (
    context.workstreamState &&
    agent.applicableStates.length > 0 &&
    !agent.applicableStates.includes(context.workstreamState) &&
    !agent.applicableStates.includes("*")
  ) {
    log.warn(
      { agentId, state: context.workstreamState, applicable: agent.applicableStates },
      "Agent invoked in non-applicable state",
    );
  }

  const instruction = assembleInstruction(agent, context);
  const permissionMode = options.permissionMode ?? agent.defaultPermissionMode;
  const maxTurns = options.maxTurns ?? agent.defaultMaxTurns;

  log.info(
    { agentId, project: context.projectId, workstream: context.workstreamName, permissionMode, maxTurns },
    "Starting agent execution",
  );

  const startTime = Date.now();

  const thread =
    (options.threadId ? await adapter.resumeThread(options.threadId) : null) ??
    await adapter.createThread(context.cwd);

  // Register output callback if provided
  if (options.onOutput) {
    const cb = options.onOutput;
    adapter.onOutput((threadId, content, isPartial) => {
      if (threadId === thread.id) {
        cb(content, isPartial);
      }
    });
  }

  // Execute the turn
  const turnResult = await adapter.startTurn({
    threadId: thread.id,
    instruction,
    cwd: context.cwd,
    model: options.model,
    systemPrompt: agent.systemPrompt,
    addDirs: context.addDirs,
    maxTurns,
    permissionMode,
    jsonSchema: options.jsonSchema,
    maxBudgetUsd: options.maxBudgetUsd,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    noSessionPersistence: options.noSessionPersistence,
  });

  const durationMs = Date.now() - startTime;

  // Parse results
  const structured = agent.structuredOutput
    ? parseStructuredOutput(turnResult.output)
    : null;

  const suggestedTrigger = extractSuggestedTrigger(agentId, structured);

  const result: AgentResult = {
    agentId,
    threadId: thread.id,
    status: turnResult.status === "completed" ? "completed" : "failed",
    output: turnResult.output,
    structured,
    summary: extractSummary(turnResult.output),
    suggestedTrigger,
    durationMs,
  };

  log.info(
    { agentId, status: result.status, durationMs, suggestedTrigger },
    "Agent execution complete",
  );

  return result;
}
