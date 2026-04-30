# Epic: assistant-infrastructure

Owns assistant capabilities, model routing, memory/context plumbing, note handling, reminders, and bounded cognition behavior.

## Scope

- Claude/Codex adapter behavior and model routing.
- Durable assistant/project context reuse.
- Planning context bundle construction.
- Cost controls, structured-output guardrails, and deterministic formatting paths.

## Boundaries

- Discord command UX belongs in `discord-routing`.
- Workstream lifecycle rules belong in `control-plane`.
- Git branch semantics belong in `git-hygiene`.

## Planning Guidance

- Default to deterministic code for formatting, question rendering, and state repair.
- Use cheap models for narrow scope framing and model updates.
- Use deep models only for bounded planning calls that receive controlled context.
