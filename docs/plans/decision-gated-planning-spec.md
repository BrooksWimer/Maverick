# Feature: Decision-Gated Workstream Planning

**Status:** Specified, ready to implement
**Depends on:** Claude Code adapter and `/workstream plan` support
**Suggested branch:** `feature/decision-gated-planning`
**Estimated scope:** Medium — orchestrator planning state + Discord follow-up flow

---

## Problem

Maverick's current `/workstream plan` flow can generate a useful Claude-authored plan, but it still leaves too much translation work on the operator.

Today the flow is effectively:

1. Claude analyzes the current workstream and writes a plan
2. Maverick stores that plan
3. The operator reads it and manually decides what to do next
4. The operator manually translates the plan into a Codex dispatch instruction

That means Maverick is helping with analysis, but it is not yet minimizing operator decision load in the way a strong technical chief-of-staff would.

## Goal

Upgrade `/workstream plan` from "generate a plan and stop" into a **decision-gated planning flow**.

Claude should:

- analyze the current codebase state, workstream history, durable epic context, and relevant repo-owned docs/artifacts
- determine the best next implementation slice
- identify the **smallest set of questions that should come back to the operator**
- distinguish between:
  - **required missing facts** that block or materially weaken execution
  - **important high-ramification decisions** that Claude might guess at, but that would meaningfully shape architecture, scope, generalization, project direction, or maintenance if guessed wrong
- synthesize the operator's answers into the final Codex execution prompt

The operator should only need to weigh in at the real decision points.

## Non-Goals

This feature is intentionally smaller than the autonomous decision queue vision.

Out of scope for this phase:

- auto-queuing the next task after every Codex turn
- Claude-driven continuous work loops
- per-project run queues
- full post-turn decision analysis
- Discord forum escalation flows
- replacing manual dispatch entirely

This feature is only about improving the **planning-to-dispatch handoff** for `/workstream plan`.

## Desired User Experience

### Current

`/workstream plan`
→ returns a plan blob
→ operator reads it
→ operator manually answers open questions in chat
→ operator manually writes a new dispatch prompt

### After This Change

`/workstream plan`
→ Claude returns:
- current state summary
- recommended next implementation slice
- required answers from the operator
- important decisions the operator should confirm
- draft final Codex prompt

Then Maverick:

- persists that planning state explicitly on the workstream
- asks the operator only the key follow-up questions
- captures answers in Discord
- feeds those answers back into the same planning flow if feasible
- or reconstructs the planning context deterministically if session reuse is not feasible
- generates the final Codex execution prompt
- makes it easy to dispatch that prompt to Codex with minimal extra translation work

## Core Design Principle

Claude should not only ask about things it literally cannot infer.

Claude should also surface decisions that are technically guessable but have **large downstream ramifications** if guessed wrong.

This is the key behavior change.

## What State Must Persist

Maverick needs durable, inspectable planning state across four moments:

1. the initial planning request
2. Claude's planning analysis and decision-gate output
3. operator answers to follow-up questions
4. the final synthesized Codex execution prompt

The persistence model should make it obvious in code review what happened and why.

At minimum Maverick should persist:

- original planning instruction
- Claude planning result
- the list of pending decision gates/questions
- operator answers
- final synthesized execution prompt
- optional Claude planning session/thread identifier if session reuse is supported

## Session Continuity

Ideal behavior:

- resume the same Claude planning session/thread when follow-up answers arrive

Acceptable fallback:

- if exact session reuse is not practical, persist enough structured planning state that Maverick can reconstruct the context deterministically and continue cleanly

The system should feel like one planning conversation, not disconnected one-off prompts.

## Discord Answer Flow

Preferred:

- use Discord polls for key decision questions when native support is practical

But this feature should **not** block on perfect poll support.

Required fallback:

- a durable structured-answer flow such as:
  - `/workstream answer`
  - `/workstream continue-plan`
  - or a clearly-scoped reply-capture flow

The important thing is that answers are structured, attached to the workstream, and reusable by the planning engine.

## Suggested Structured Planning Result

Claude should produce a structured result shaped like:

```json
{
  "currentStateSummary": "What is already true in the repo and workstream",
  "recommendedNextSlice": "The best next implementation slice",
  "requiredAnswers": [
    {
      "id": "login-form-fields",
      "question": "What fact is needed?",
      "whyItMatters": "Why execution is blocked or weakened without it"
    }
  ],
  "importantDecisions": [
    {
      "id": "xfinity-overfit-boundary",
      "question": "What should be confirmed?",
      "whyItMatters": "What large downstream consequence this affects"
    }
  ],
  "draftExecutionPrompt": "The prompt Codex should receive once answers are known"
}
```

The exact schema can change during implementation, but the behavior should match this shape.

## Example

For router-admin ingestion, Claude should not stop at:

- "here is the plan"

It should continue with:

- "I need three facts from you before I finalize execution"
- "I also want confirmation on one architectural choice that affects generalization"

Then after the operator answers, Maverick should generate the final Codex prompt directly.

## Implementation Guidance

The smallest durable implementation is likely:

1. extend the stored workstream planning state beyond a single `plan` string
2. add an explicit pending-planning-questions state model
3. add a Discord command/path for answering planning questions
4. add a planning continuation step that synthesizes the answers into the final Codex prompt
5. keep manual review/dispatch as the final explicit operator action for V1

That keeps the feature scoped while still delivering the real value.

## Acceptance Criteria

- `/workstream plan` no longer returns only a raw plan blob
- planning output explicitly separates:
  - current state summary
  - recommended next slice
  - required answers
  - important decisions to confirm
  - draft final Codex prompt
- planning state is durably attached to the workstream
- operator answers can be fed back into the same planning flow or a deterministic reconstruction of it
- Maverick can generate a final Codex execution prompt from:
  - the original planning request
  - Claude's planning analysis
  - stored planning state
  - operator answers
- Discord UX is workable even without poll support
- the implementation is documented and tested
- the design remains explicit, inspectable, and scoped

## Relationship to the Larger Decision Queue Vision

This feature was a narrow precursor to the broader decision-queue idea, which was removed during the stabilization cut.

That larger spec asks Claude to keep work moving continuously after each turn.
This feature does **not** do that.

Instead, this feature improves one critical seam:

- turning Claude planning into a structured operator decision handoff
- and then into a Codex-ready execution prompt

If implemented well, it becomes the foundation Maverick can later reuse for a broader decision queue.
