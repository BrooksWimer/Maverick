---
name: security-review
description: Apply explicit security scrutiny to code paths that could expose secrets, data, execution, or permissions risk.
---

# Security Review

Use this skill whenever a slice touches auth, secrets, data access, shell execution, network calls, uploads, logging, or permissions.

## Core Checks

- Secrets and credentials
- Unsafe shell or command execution
- Injection paths
- Overly broad permissions or file access
- Sensitive data exposure in logs, errors, or responses
- Dependency and configuration risk when new packages or services are introduced

## Workflow

1. Identify whether the change touches a sensitive surface.
2. Search for the concrete data flow or execution path.
3. Inspect the exact code that accepts, transforms, stores, logs, or executes the input.
4. Record what was checked, not just whether it "looks safe."
5. If risk remains, surface it explicitly in review or verification output.

## Output Expectations

State:

- what security-sensitive surface was reviewed
- what evidence was checked
- any remaining caveats or follow-up work
