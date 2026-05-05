import type { PlanningContextPayload, ReviewContextPayload } from "./types.js";

export function buildReviewSystemPrompt(): string {
  return [
    "You are reviewing another agent's implementation.",
    "Be specific about correctness risk, regressions, and missing verification.",
    "Return strict JSON with keys severity, findings, suggestions.",
    "Use severity values clean, minor, major, or critical.",
  ].join(" ");
}

export function buildReviewInstruction(context: ReviewContextPayload): string {
  return [
    "Review this completed Codex turn.",
    "Return JSON only in this exact shape:",
    '{"severity":"clean|minor|major|critical","findings":"...","suggestions":["..."]}',
    "",
    `Project: ${context.projectId}`,
    `Workstream: ${context.workstreamName}`,
    `Instruction: ${context.instruction}`,
    context.turnSummary ? `Turn summary: ${context.turnSummary}` : null,
    context.epicCharter ? `Epic charter: ${context.epicCharter}` : "Epic charter: none recorded",
    context.testResults ? `Relevant test results: ${context.testResults}` : "Relevant test results: none recorded yet",
    "",
    "Git status:",
    context.gitStatus || "(empty)",
    "",
    "Git diff:",
    context.gitDiff || "(no diff)",
    "",
    "Turn output:",
    context.turnOutput || "(empty)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildPlanningSystemPrompt(): string {
  return [
    "You are writing an implementation plan for another agent to execute.",
    "Be concrete about files to inspect or modify, changes to make, and verification to run.",
    "Prefer ordered checkpoints that a coding agent can follow without guesswork.",
  ].join(" ");
}

export function buildPlanningInstruction(context: PlanningContextPayload): string {
  return [
    "Write a focused implementation plan for this workstream.",
    "Requirements:",
    "- Use ordered phases or steps.",
    "- Call out the files or directories to touch when you can infer them from context.",
    "- End with verification expectations.",
    "",
    `Project: ${context.projectId}`,
    `Workstream: ${context.workstreamName}`,
    `Instruction: ${context.instruction}`,
    context.epicCharter ? `Epic charter: ${context.epicCharter}` : "Epic charter: none recorded",
    "",
    "AGENTS.md:",
    context.agentsMd,
    "",
    "Directory tree:",
    context.directoryTree,
    "",
    "Recent turn history:",
    JSON.stringify(context.recentTurnHistory, null, 2),
  ].join("\n");
}
