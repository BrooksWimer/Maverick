import type { BriefContext, BriefTrigger } from "./types.js";

function slugTimestamp(timestamp: string): string {
  return timestamp.replace(/[:]/g, "-");
}

export function briefFilename(generatedAt: string): string {
  return `maverick-brief-${slugTimestamp(generatedAt)}.md`;
}

export function summarizeBrief(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return "Claude generated an empty brief.";
  }

  return firstLine.length <= 140 ? firstLine : `${firstLine.slice(0, 137)}...`;
}

export function renderBriefMarkdown(params: {
  trigger: BriefTrigger;
  generatedAt: string;
  content: string;
  context: BriefContext;
}): string {
  const projectCount = params.context.projects.length;
  const approvalCount = params.context.projects.reduce(
    (total, project) => total + project.pendingApprovals.length,
    0
  );

  return [
    "# Maverick Brief",
    "",
    `- Generated: ${params.generatedAt}`,
    `- Trigger: ${params.trigger}`,
    `- Coverage window start: ${params.context.since}`,
    `- Projects summarized: ${projectCount}`,
    `- Pending approvals: ${approvalCount}`,
    "",
    "## Brief",
    "",
    params.content.trim() || "_Claude returned no brief text._",
  ].join("\n");
}
