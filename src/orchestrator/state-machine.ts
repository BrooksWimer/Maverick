/**
 * Data-driven workstream state machine.
 *
 * Unlike a hardcoded state machine, this reads transitions from the project's
 * workflow config. Different projects can have different flows (e.g., a quick
 * hotfix workflow vs. a full feature workflow with review gates).
 */
import type { WorkflowConfig, StateTransition } from "../config/schema.js";
import { DEFAULT_WORKFLOW } from "../config/schema.js";
import { createLogger } from "../logger.js";

const log = createLogger("state-machine");

export interface TransitionResult {
  allowed: boolean;
  from: string;
  to: string;
  trigger: string;
  autoAdvance: boolean;
  reason?: string;
}

export class WorkstreamStateMachine {
  private readonly workflow: WorkflowConfig;
  private readonly transitionMap: Map<string, StateTransition[]>;

  constructor(workflow?: WorkflowConfig) {
    this.workflow = workflow ?? DEFAULT_WORKFLOW;
    this.transitionMap = new Map();

    // Index transitions by source state for fast lookup
    for (const t of this.workflow.transitions) {
      const existing = this.transitionMap.get(t.from) ?? [];
      existing.push(t);
      this.transitionMap.set(t.from, existing);
    }
  }

  get initialState(): string {
    return this.workflow.initialState;
  }

  get terminalStates(): string[] {
    return this.workflow.terminalStates;
  }

  get states(): string[] {
    return this.workflow.states;
  }

  /**
   * Check if a transition is valid from the current state.
   */
  canTransition(currentState: string, trigger: string): TransitionResult {
    const transitions = this.transitionMap.get(currentState);
    if (!transitions) {
      return {
        allowed: false,
        from: currentState,
        to: currentState,
        trigger,
        autoAdvance: false,
        reason: `No transitions defined from state "${currentState}"`,
      };
    }

    const match = transitions.find(t => t.trigger === trigger);
    if (!match) {
      const available = transitions.map(t => t.trigger).join(", ");
      return {
        allowed: false,
        from: currentState,
        to: currentState,
        trigger,
        autoAdvance: false,
        reason: `Trigger "${trigger}" not valid from "${currentState}". Available: ${available}`,
      };
    }

    return {
      allowed: true,
      from: currentState,
      to: match.to,
      trigger,
      autoAdvance: match.autoAdvance,
    };
  }

  /**
   * Perform a transition. Returns the new state or throws if invalid.
   */
  transition(currentState: string, trigger: string): string {
    const result = this.canTransition(currentState, trigger);
    if (!result.allowed) {
      throw new Error(result.reason);
    }
    log.info({ from: result.from, to: result.to, trigger }, "State transition");
    return result.to;
  }

  /**
   * Get all valid triggers from the current state.
   */
  availableTriggers(currentState: string): string[] {
    const transitions = this.transitionMap.get(currentState) ?? [];
    return transitions.map(t => t.trigger);
  }

  /**
   * Check if a state is terminal (work is done).
   */
  isTerminal(state: string): boolean {
    return this.workflow.terminalStates.includes(state);
  }

  /**
   * Get the transitions that auto-advance from a given state.
   * Used by the orchestrator to automatically progress workstreams.
   */
  getAutoAdvanceTransitions(currentState: string): StateTransition[] {
    const transitions = this.transitionMap.get(currentState) ?? [];
    return transitions.filter(t => t.autoAdvance);
  }

  /**
   * Serialize the workflow for display/debugging.
   */
  toJSON(): WorkflowConfig {
    return this.workflow;
  }
}
