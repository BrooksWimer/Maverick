import { isAbsolute, relative, resolve } from "node:path";
import type { EpicBranchConfig, ProjectConfig } from "../config/schema.js";

function isPathWithinRoot(candidatePath: string, allowedRoot: string): boolean {
  const normalizedRoot = resolve(allowedRoot);
  const normalizedCandidate = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(allowedRoot, candidatePath);
  const relativePath = relative(normalizedRoot, normalizedCandidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(":"));
}

export function workstreamLaneForEpic(epic: EpicBranchConfig): string {
  return epic.workstreamPrefix ?? epic.id;
}

export function getEpicById(project: ProjectConfig, epicId: string): EpicBranchConfig | undefined {
  return project.epicBranches.find((candidate) => candidate.id === epicId);
}

export function requireEpicById(project: ProjectConfig, epicId: string): EpicBranchConfig {
  const epic = getEpicById(project, epicId);
  if (!epic) {
    throw new Error(`Project "${project.id}" does not define epic "${epicId}".`);
  }
  return epic;
}

export function resolveEpicDocPath(project: Pick<ProjectConfig, "repoPath">, docPath: string): string {
  return isAbsolute(docPath) ? resolve(docPath) : resolve(project.repoPath, docPath);
}

export function isEpicDocPathWithinProject(project: Pick<ProjectConfig, "repoPath">, docPath: string): boolean {
  return isPathWithinRoot(resolveEpicDocPath(project, docPath), project.repoPath);
}

export function buildEpicCharterContext(project: ProjectConfig, epic: EpicBranchConfig): string | null {
  const charter = epic.charter;
  if (!charter) {
    return null;
  }

  const lines = [
    "Maverick durable epic context:",
    `Project: ${project.name} (${project.id})`,
    `Epic: ${epic.id}`,
    epic.description ? `Lane summary: ${epic.description}` : null,
    `Charter: ${charter.summary}`,
    charter.bullets.length > 0 ? "Key context:" : null,
    ...charter.bullets.map((bullet) => `- ${bullet}`),
    charter.docs.length > 0 ? "Repo-owned durable docs:" : null,
    ...charter.docs.map((doc) => {
      const resolvedPath = resolveEpicDocPath(project, doc.path);
      return doc.purpose ? `- ${resolvedPath}: ${doc.purpose}` : `- ${resolvedPath}`;
    }),
    "Treat this as durable product intent for the epic. Keep implementation details and new findings in the repo-owned docs above.",
  ].filter((line): line is string => Boolean(line));

  return lines.join("\n");
}
