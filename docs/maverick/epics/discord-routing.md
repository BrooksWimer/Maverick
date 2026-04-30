# Epic: discord-routing

Owns Discord as the operator surface for Maverick workstreams, assistant replies, thread binding, command UX, and message formatting.

## Scope

- Slash command behavior and command options.
- Forum/thread routing and binding repair.
- Error messages and operator next-action guidance.
- Discord-safe formatting for planning, verification, finish, and promotion results.

## Boundaries

- Core lifecycle state changes belong in `control-plane`.
- Deployment health belongs in `deployment-ops`.
- Assistant memory internals belong in `assistant-infrastructure`.

## Planning Guidance

- Unknown threads should fail with repair help instead of falling back to production/default branches.
- Thread slugs should resolve to configured epic ids.
- Responses should be concise, explicit about background work, and clear about where results will appear.
