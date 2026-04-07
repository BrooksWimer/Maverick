# Epic Charters

Epic charters are the durable product-intent layer that Maverick can attach to an epic lane.

## Source Of Truth

Define charters in `config/control-plane.json` under:

- `projects[].epicBranches[].charter.summary`
- `projects[].epicBranches[].charter.bullets`
- `projects[].epicBranches[].charter.docs`

The charter belongs to Maverick because it is orchestration metadata. Repo-owned docs listed in
`charter.docs` remain the durable home for implementation details, discoveries, and artifacts.

## Dispatch Behavior

When a workstream is created with an `epicId`, Maverick persists that epic selection on the
workstream. On dispatch, Maverick prepends a deterministic "Maverick durable epic context" block
before the user instruction whenever that epic defines a charter.

That means a new workstream starts with:

- structural context from repo, worktree, branch, and AGENTS bootstrap
- durable product and epic intent from the epic charter

The raw user instruction is still stored as the turn instruction in Maverick state. The injected
charter is derived from config at dispatch time.

## Doc Pointers

Use `charter.docs` for repo-owned references that agents should consult when they need durable
details. Paths may be repo-relative or absolute, but they must stay inside the project repo root.

Example:

```json
{
  "id": "router-admin-ingestion",
  "branch": "codex/router-admin-ingestion-epic",
  "workstreamPrefix": "router-admin-ingestion",
  "charter": {
    "summary": "Authenticated router admin ingestion is a real product capability.",
    "bullets": [
      "Start with Xfinity at http://10.0.0.1 without hardcoding the design to one vendor."
    ],
    "docs": [
      {
        "path": "agent/docs/WIFI_STRATEGY_CATALOG.md",
        "purpose": "Related repo-owned strategy notes."
      }
    ]
  }
}
```
