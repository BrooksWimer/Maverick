---
name: verify
description: Run the relevant verification loop, capture evidence, and decide whether the current slice is ready for review.
---

# Verify

Use this skill before review and after applying review feedback.

## Doctrine

- Follow `tdd-workflow`: prefer checks that correspond directly to the changed behavior.
- Follow `security-review` when code touches secrets, auth, data handling, shell usage, or permissions.
- Follow `deployment-patterns` when CI, rollout, infra, or runtime configuration is in scope.

## Verification Loop

1. Detect the relevant checks from the repo:
   tests, lint, typecheck, build, security, deployment, or project-specific validators.
2. Run the narrowest useful checks while iterating.
3. Run the full relevant suite before declaring review readiness.
4. Capture evidence for every executed check:
   command, result, and the important output.
5. Distinguish introduced failures from background noise whenever possible.
6. If any introduced failure remains, return to implementation with explicit fix targets.

## Minimum Expectations

- Do not skip an available check without saying why.
- Do not mark a slice as review-ready if introduced failures remain.
- If rollout or deployment logic changed, include rollback and operational validation notes.
- If a security-sensitive area changed, state what was checked.

## Output Expectations

The final verification handoff should clearly show:

- checks run
- pass/fail status
- key evidence
- introduced failures
- remaining risks
- exact next action
