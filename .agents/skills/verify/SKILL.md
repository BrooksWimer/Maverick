---
name: verify
description: Run project verification checks, capture evidence, and determine whether a workstream is ready for review.
---

---
name: verify
description: Run project verification checks, capture evidence, and determine whether a workstream is ready for review.
---

---
name: verify
description: Run project verification checks, capture evidence, and determine whether a workstream is ready for review.
---

# Verify

Run verification checks and produce structured evidence of pass/fail status.

## When to use
Use this skill after implementation is complete, before moving to Review state.
Also use after applying review feedback to confirm fixes.

## Process

1. **Identify verification targets**: What should be checked? (tests, lint, build, types, etc.)
2. **Run checks**: Execute each verification command and capture output.
3. **Analyze results**: Parse output for failures, warnings, and errors.
4. **Produce evidence report**: Structured summary of what passed and what failed.
5. **Decide**: If all pass → ready for review. If any fail → return to implementation with specific fix targets.

## Verification commands (detect from project)

- **Tests**: Look for `npm test`, `pytest`, `go test`, `cargo test`, or project-specific test commands
- **Lint**: Look for `eslint`, `ruff`, `golangci-lint`, or similar
- **Build**: Look for `npm run build`, `tsc`, `go build`, `cargo build`
- **Types**: Look for `tsc --noEmit`, `mypy`, `pyright`

## Output format

```markdown
## Verification Report
**Status**: PASS / FAIL
**Checks run**:
- [x] Tests: [pass/fail] - [summary]
- [x] Lint: [pass/fail] - [summary]
- [x] Build: [pass/fail] - [summary]
- [x] Types: [pass/fail] - [summary]

**Failures** (if any):
- [description of failure + suggested fix]

**Recommendation**: [ready-for-review / needs-fixes]
```

## Important
Never mark verification as passed if any check fails.
Never skip checks that are available in the project.
If a check is not applicable, note it as "N/A" with reason.
