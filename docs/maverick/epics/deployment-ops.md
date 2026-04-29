# Epic: deployment-ops

Owns Maverick runtime operations across Windows and Linux: service restarts, health checks, environment files, shared state, and deployment safety.

## Scope

- Windows and Linux bot restart procedures.
- Runtime health checks and ownership visibility.
- Environment/deploy documentation.
- Cross-host shared state coordination.

## Boundaries

- Discord command design belongs in `discord-routing`.
- Core lifecycle code belongs in `control-plane`.

## Planning Guidance

- Treat restarts and deploy changes as operator-visible events with rollback paths.
- Avoid host-specific config drift.
- Verify with build/tests plus live health where possible.
