---
name: workstream-intake
description: Turn a vague request into a scoped, actionable Maverick workstream with explicit acceptance criteria, risks, and recommendation.
---

# Workstream Intake

Use this skill when a request is still fuzzy and needs to become a clean workstream definition.

## Doctrine

- Use `search-first` before scoping.
- Use `iterative-retrieval` to expand context only when the repo evidence requires it.
- Prefer the smallest durable slice that can be planned and dispatched cleanly.

## Process

1. Read the request and restate the desired outcome in plain language.
2. Search the repo for the relevant modules, adjacent patterns, and recent related work.
3. Identify scope boundaries:
   what is in scope, what is explicitly out of scope, and what assumptions are being made.
4. Write testable acceptance criteria.
5. Capture risks, hidden dependencies, and the most likely operator questions.
6. End with a recommendation:
   `proceed`, `needs-clarification`, or `split-into-multiple`.

## Output Expectations

Produce a concise intake summary that makes these fields obvious:

- request
- scope
- out of scope
- acceptance criteria
- risks
- complexity
- recommendation

## Escalation

Do not push unclear work into planning just to keep momentum.
If the repo evidence is incomplete or the scope boundary is still ambiguous, escalate with specific clarification needs.
