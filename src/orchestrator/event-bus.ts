/**
 * Internal event bus for decoupling modules.
 *
 * The orchestrator emits events; Discord, HTTP, and logging modules subscribe.
 * This is what makes it possible to build core logic first and wire Discord later.
 */
import EventEmitter from "eventemitter3";
import type { BriefTrigger } from "../claude/types.js";
import type { PendingPlanningDecision } from "../agents/types.js";

// --- Event types ---

export interface WorkstreamCreatedEvent {
  workstreamId: string;
  projectId: string;
  name: string;
}

export interface WorkstreamStateChangedEvent {
  workstreamId: string;
  from: string;
  to: string;
  trigger: string;
}

export interface TurnStartedEvent {
  workstreamId: string;
  turnId: string;
  instruction: string;
}

export interface TurnCompletedEvent {
  workstreamId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "needs_approval";
  summary?: string;
  output?: string;
}

export interface TurnOutputEvent {
  workstreamId: string;
  turnId: string;
  content: string;
  isPartial: boolean;
}

export interface ApprovalRequestedEvent {
  workstreamId: string;
  approvalId: string;
  type: string;
  description: string;
  tier: string;
}

export interface ApprovalResolvedEvent {
  workstreamId: string;
  approvalId: string;
  status: "approved" | "denied";
  decidedBy: string;
}

export interface DecisionNeededEvent {
  workstreamId: string;
  trigger: "manual" | "auto" | "resume";
  instruction: string;
  questions: PendingPlanningDecision[];
  renderedPlan: string;
  formattedMarkdown: string;
}

export interface PlanGeneratedEvent {
  workstreamId: string;
  trigger: "manual" | "auto" | "resume";
  instruction: string;
  renderedPlan: string;
  formattedMarkdown: string;
  finalExecutionPrompt: string | null;
  needsAnswers: boolean;
}

export interface ErrorEvent {
  workstreamId?: string;
  error: Error;
  context?: string;
}

export interface BriefGeneratedEvent {
  trigger: BriefTrigger;
  generatedAt: string;
  content: string;
  markdown: string;
  summary: string;
  storagePath: string | null;
  channelId: string | null;
}

export interface ReviewCompletedEvent {
  workstreamId: string;
  reviewer: "claude";
  severity: "clean" | "minor" | "major" | "critical";
  findings: string;
  suggestions: string[];
  target: string;
}

export interface VerificationCompletedEvent {
  workstreamId: string;
  trigger: "manual" | "auto";
  status: "pass" | "fail";
  recommendation: "ready-for-review" | "needs-fixes";
  renderedVerification: string;
}

// --- Event map ---

export interface OrchestratorEvents {
  "workstream.created": (event: WorkstreamCreatedEvent) => void;
  "workstream.stateChanged": (event: WorkstreamStateChangedEvent) => void;
  "turn.started": (event: TurnStartedEvent) => void;
  "turn.completed": (event: TurnCompletedEvent) => void;
  "turn.output": (event: TurnOutputEvent) => void;
  "approval.requested": (event: ApprovalRequestedEvent) => void;
  "approval.resolved": (event: ApprovalResolvedEvent) => void;
  "decision.needed": (event: DecisionNeededEvent) => void;
  "plan.generated": (event: PlanGeneratedEvent) => void;
  "brief.generated": (event: BriefGeneratedEvent) => void;
  "verification.completed": (event: VerificationCompletedEvent) => void;
  "review.completed": (event: ReviewCompletedEvent) => void;
  "error": (event: ErrorEvent) => void;
}

// --- Event bus singleton ---

class OrchestratorEventBus extends EventEmitter<OrchestratorEvents> {}

export const eventBus = new OrchestratorEventBus();
