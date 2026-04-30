---
name: deployment-patterns
description: Apply rollout, rollback, and operational reasoning when a slice touches deployment, CI, infra, or runtime configuration.
---

# Deployment Patterns

Use this skill when a change touches:

- deployment scripts
- runtime configuration
- CI workflows
- infra definitions
- service startup or restart behavior
- operational rollout or rollback procedures

## Core Rules

- Think about blast radius before editing.
- Prefer reversible changes.
- Make rollback explicit.
- Validate the changed path with the closest realistic check available.

## Workflow

1. Identify what environment or runtime surface the change affects.
2. Determine the likely blast radius if the change is wrong.
3. Plan validation for both the happy path and rollback path.
4. Record any required approvals before mutating CI, infra, or remote systems.
5. Include the operational next step in the final handoff.

## Output Expectations

A strong deployment-aware handoff includes:

- affected surface
- rollout risk
- validation evidence
- rollback plan
- exact next action for the operator
