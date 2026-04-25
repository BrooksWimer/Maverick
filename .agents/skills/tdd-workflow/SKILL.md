---
name: tdd-workflow
description: Use test-first or test-guided execution so implementation stays anchored to observable behavior.
---

# TDD Workflow

Use this skill for implementation planning and execution whenever the behavior can be tested.

## Core Rules

- Prefer writing or identifying the failing test before the final code change.
- Keep tests close to the behavior being changed.
- Let verification checkpoints shape the implementation slice.
- If full TDD is not practical, stay test-guided and explain why.

## Workflow

1. Identify the observable behavior that should change.
2. Find the closest existing tests or create the missing coverage.
3. Make the behavior fail in the expected way when practical.
4. Implement the smallest change that makes the test pass.
5. Run the focused checks, then the broader relevant suite.

## Output Expectations

Call out:

- which tests were added or updated
- which behavior they protect
- what broader verification was run after the focused loop
