---
name: search-first
description: Ground every implementation slice in the actual repository before proposing or changing code.
---

# Search First

Use this skill at the beginning of any non-trivial implementation, planning, verification, or review task.

## Core Rules

- Read the repo before asserting how it works.
- Search adjacent modules and tests before introducing new patterns.
- Check recent changes when the current behavior may have moved recently.
- Prefer primary evidence from code, config, tests, and docs over assumptions.

## Process

1. Identify the likely entrypoints, owning modules, and existing tests.
2. Search for related symbols, strings, or workflows.
3. Read the closest relevant files before deciding on a plan.
4. Look for existing helpers or conventions before creating new ones.
5. Confirm whether similar work already exists in another path.

## Done Well

You should be able to answer:

- where the behavior lives now
- what existing pattern the change should follow
- which tests or validation paths already cover the area
