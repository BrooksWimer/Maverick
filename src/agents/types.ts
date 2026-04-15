/**
 * Shared types for Maverick custom agents.
 *
 * Each agent is a purpose-built, multi-step worker that operates within
 * the orchestrator's state machine. Unlike the single-shot Claude CLI
 * invocations in src/claude/, these agents define explicit tool sets,
 * structured outputs, and multi-turn execution plans.
 */

import type { ClaudePermissionMode } from "../claude/types.js";

// ---------------------------------------------------------------------------
// Agent identity & configuration
// ---------------------------------------------------------------------------

export type AgentId =
  | "intake"
  | "goal-framing"
  | "planning"
  | "operator-feedback"
  | "response-formatting"
  | "modeling"
  | "test-design"
  | "verification"
  | "review"
  | "epic-context"
  | "merge"
  | "incident-triage"
  | "brief";

export interface AgentDefinition {
  /** Unique agent identifier */
  id: AgentId;

  /** Human-readable name */
  name: string;

  /** Short description of what this agent does */
  description: string;

  /** System prompt that defines the agent's persona, constraints, and output format */
  systemPrompt: string;

  /** Which workstream states this agent is relevant to */
  applicableStates: string[];

  /** Default permission mode for Claude CLI invocation */
  defaultPermissionMode: ClaudePermissionMode;

  /** Default max turns for agent execution */
  defaultMaxTurns: number;

  /** Tool definitions the agent can invoke */
  tools: AgentToolDefinition[];

  /** Whether this agent produces structured JSON output */
  structuredOutput: boolean;
}

// ---------------------------------------------------------------------------
// Agent tools — what each agent can do
// ---------------------------------------------------------------------------

export interface AgentToolDefinition {
  /** Tool name (used in system prompt and for dispatch) */
  name: string;

  /** Human description of what the tool does */
  description: string;

  /** Parameter schema (JSON Schema subset) */
  parameters: Record<string, ToolParameter>;

  /** Required parameter names */
  required: string[];
}

export interface ToolParameter {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: ToolParameter;
  default?: unknown;
}

// ---------------------------------------------------------------------------
// Agent context — what gets passed into each agent
// ---------------------------------------------------------------------------

export interface AgentContext {
  /** Project identifier */
  projectId: string;

  /** Project repo path */
  repoPath: string;

  /** Workstream ID (if bound to a workstream) */
  workstreamId?: string;

  /** Workstream name */
  workstreamName?: string;

  /** Current workstream state */
  workstreamState?: string;

  /** The user's original instruction / request */
  instruction: string;

  /** Working directory for execution */
  cwd: string;

  /** Additional directories to add to Claude's context */
  addDirs?: string[];

  /** Epic charter context (if bound to an epic) */
  epicCharter?: string | null;

  /** AGENTS.md content */
  agentsMd?: string;

  /** Arbitrary extra context keyed by name */
  extra: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Agent results — structured output from each agent
// ---------------------------------------------------------------------------

export interface AgentResult {
  /** Which agent produced this result */
  agentId: AgentId;

  /** Claude/Codex thread used for this agent run */
  threadId: string;

  /** Did the agent complete successfully */
  status: "completed" | "failed" | "needs-escalation";

  /** Free-form output text */
  output: string;

  /** Structured data (agent-specific, parsed from output) */
  structured: Record<string, unknown> | null;

  /** Summary for storage in workstream events */
  summary: string;

  /** Suggested next state transition trigger (if any) */
  suggestedTrigger?: string;

  /** Files the agent read or referenced */
  filesReferenced?: string[];

  /** How long the agent ran (ms) */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Agent-specific structured output types
// ---------------------------------------------------------------------------

/** Intake agent output */
export interface IntakeResult {
  request: string;
  scope: string;
  outOfScope: string;
  acceptanceCriteria: string[];
  risks: string[];
  complexity: "small" | "medium" | "large";
  recommendation: "proceed" | "needs-clarification" | "split-into-multiple";
  clarificationQuestions?: string[];
}

/** Goal framing agent output */
export interface GoalFrameResult {
  objective: string;
  problemStatement: string;
  successCriteria: string[];
  constraints: string[];
  assumptions: string[];
  autonomyGuidance: string;
  operatorDecisionPolicy: string;
}

/** Operator feedback agent output */
export interface OperatorFeedbackResult {
  headline: string;
  preface: string;
  questions: OperatorFeedbackQuestion[];
  answerInstructions: string;
  suggestedReplyFormat: string;
}

export interface OperatorFeedbackQuestion {
  questionId: string;
  label: string;
  prompt: string;
  whyItMatters: string;
  options: string[];
  recommendedOption?: string;
}

/** Response formatting / explanation output */
export interface ExplanationResult {
  headline: string;
  summary: string;
  markdown: string;
  nextAction: string;
}

/** Modeling agent output */
export interface ModelingResult {
  systemSummary: string;
  mermaid: string;
  keyEntities: string[];
  criticalFlows: string[];
  openQuestions: string[];
}

/** Test design agent output */
export interface TestDesignResult {
  strategySummary: string;
  testCases: TestDesignCase[];
  verificationChecklist: string[];
  suggestedCommands: string[];
}

export interface TestDesignCase {
  name: string;
  scope: "unit" | "integration" | "e2e";
  purpose: string;
  files: string[];
}

/** Planning agent output */
export interface PlanningResult {
  currentStateSummary: string;
  recommendedNextSlice: string;
  requiredAnswers: PlanningDecision[];
  importantDecisions: PlanningDecision[];
  draftExecutionPrompt: string;
  finalExecutionPrompt: string;
  remainingUnknowns: string[];
  steps: PlanStep[];
  risks: string[];
  dependencies: string[];
  estimatedTurns: number;
  testStrategy: string;
  rollbackPlan: string;
}

export interface PlanningDecision {
  id: string;
  question: string;
  whyItMatters: string;
  options?: string[];
}

export interface PlanStep {
  order: number;
  description: string;
  files: string[];
  verification: string;
  canParallelize: boolean;
}

export interface PendingPlanningDecision extends PlanningDecision {
  kind: "required-answer" | "important-decision";
}

export interface PlanningAnswer {
  questionId: string;
  answer: string;
  answeredAt: string;
  answeredBy: string | null;
}

export interface PlanningContextRecord {
  schemaVersion: number;
  originalInstruction: string;
  planningThreadId: string | null;
  intake: IntakeResult | null;
  goalFrame: GoalFrameResult | null;
  modeling: ModelingResult | null;
  testDesign: TestDesignResult | null;
  feedbackRequest: OperatorFeedbackResult | null;
  explanation: ExplanationResult | null;
  result: PlanningResult;
  pendingQuestions: PendingPlanningDecision[];
  answers: Record<string, PlanningAnswer>;
  finalExecutionPrompt: string | null;
  status: "needs-answers" | "needs-final-prompt" | "ready";
  rawAgentOutput: string;
  createdAt: string;
  updatedAt: string;
}

/** Verification agent output */
export interface VerificationResult {
  status: "pass" | "fail";
  checks: VerificationCheck[];
  preExistingFailures: string[];
  introducedFailures: string[];
  recommendation: "ready-for-review" | "needs-fixes";
  fixTargets?: string[];
}

export interface VerificationCheck {
  name: string;
  command: string;
  status: "pass" | "fail" | "skipped" | "error";
  output: string;
  duration_ms: number;
}

export interface VerificationContextRecord {
  schemaVersion: number;
  verificationThreadId: string | null;
  sourceTurnId: string | null;
  trigger: "manual" | "auto";
  result: VerificationResult;
  incidentTriage: IncidentTriageResult | null;
  rawAgentOutput: string;
  createdAt: string;
  updatedAt: string;
}

/** Review agent output */
export interface ReviewResult {
  verdict: "ship" | "ship-with-caveats" | "needs-changes" | "reject";
  severity: "clean" | "minor" | "major" | "critical";
  passes: ReviewPass[];
  securityFindings: ReviewFinding[];
  architectureFindings: ReviewFinding[];
  correctnessFindings: ReviewFinding[];
  conventionFindings: ReviewFinding[];
  suggestions: string[];
}

export interface ReviewPass {
  name: string;
  status: "clean" | "findings";
  findingCount: number;
}

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: "info" | "warning" | "error" | "critical";
  category: string;
  description: string;
  suggestion?: string;
}

/** Epic context agent output */
export interface EpicContextResult {
  epicId: string;
  summary: string;
  completedWorkstreams: string[];
  activeWorkstreams: string[];
  blockedItems: string[];
  recentDecisions: string[];
  openQuestions: string[];
  contextForNextWorkstream: string;
}

/** Merge agent output */
export interface MergeResult {
  status: "merged" | "conflicts" | "blocked";
  conflictFiles?: string[];
  verificationPassed: boolean;
  changelogEntry: string;
  mergeCommitSha?: string;
  rollbackCommand?: string;
}

/** Incident triage agent output */
export interface IncidentTriageResult {
  severity: "low" | "medium" | "high" | "critical";
  rootCause: string;
  correlatedChanges: string[];
  suggestedFix: string;
  affectedWorkstreams: string[];
  escalationNeeded: boolean;
  escalationReason?: string;
}

/** Brief agent output */
export interface BriefResult {
  sections: BriefSection[];
  criticalAlerts: string[];
  velocityTrend: "accelerating" | "steady" | "slowing" | "stalled";
  stuckWorkstreams: string[];
  risksIdentified: string[];
  recommendedActions: string[];
}

export interface BriefSection {
  projectId: string;
  headline: string;
  delta: string;
  blockers: string[];
  nextActions: string[];
}
