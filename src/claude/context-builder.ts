import type { BriefContext, PlanningContextPayload, ReviewContextPayload } from "./types.js";

export function buildBriefSystemPrompt(): string {
  return [
    "You are Maverick's nightly operations analyst.",
    "Write a concise operating brief grounded only in the supplied evidence.",
    "Lead with what matters most, call out risk explicitly, and separate completed work from open issues.",
    "Do not invent activity that is not present in the context.",
  ].join(" ");
}

export function buildBriefInstruction(context: BriefContext): string {
  return [
    "Synthesize the following Maverick control-plane context into a concise daily brief.",
    "Format requirements:",
    "- Start with a short title line.",
    "- Then include sections: Top Priorities, Project Snapshot, Pending Decisions, Upcoming Items.",
    "- Use bullets where helpful, but keep it readable in Discord and Markdown.",
    "- Mention concrete project ids, workstream names, branches, dirty repos, pending approvals, and reminders when they matter.",
    "",
    "Context JSON:",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

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
