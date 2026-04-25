---
name: iterative-retrieval
description: Gather context in tight loops so planning and implementation stay evidence-driven without ballooning scope.
---

# Iterative Retrieval

Use this skill when the first search pass is not enough.

## Core Rules

- Start narrow.
- Widen only when the evidence requires it.
- Summarize what each retrieval pass changed in your understanding.
- Stop when additional searching is no longer changing the plan.

## Retrieval Loop

1. Start with the most likely files or symbols.
2. Read just enough to form the next focused question.
3. Search again using what you learned.
4. Repeat until the implementation path, risks, and validation plan are clear.

## Signals To Expand

- The current file references a second system you have not read yet.
- The validation path is unclear.
- The code suggests hidden coupling or generated behavior.
- The operator request conflicts with what the repo appears to do today.

## Signals To Stop

- The next slice is clear.
- The relevant files and tests are identified.
- Additional reading is no longer changing the recommended action.
