import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { OrchestratorConfig } from "../config/index.js";
import type {
  AssistantAttachment,
  AssistantMessageSource,
  WorkNoteKind,
  WorkNotesConfig,
  WorkSmartGoal,
} from "./types.js";

const DEFAULT_WORK_SMART_GOALS: WorkSmartGoal[] = [
  {
    id: "business-context",
    title: "Business Context Deep Dives",
    description:
      "Do a deep dive into facets of the business that come up through work to build stronger business understanding.",
  },
  {
    id: "engineering-learning",
    title: "Independent Engineering Learning",
    description:
      "Do independent software engineering reading, make notes on it, and keep track of active learning.",
  },
];

export type PersistedWorkAttachment = {
  originalName: string;
  sourceUrl: string | null;
  contentType: string | null;
  relativePath: string | null;
  status: "saved" | "remote-only" | "failed";
  error: string | null;
};

export type PersistWorkNoteResult = {
  storagePath: string;
  attachments: PersistedWorkAttachment[];
};

export function createWorkNotesConfig(config: OrchestratorConfig): WorkNotesConfig | null {
  const project =
    config.projects.find((candidate) => candidate.id === "work") ??
    config.projects.find((candidate) => candidate.metadata?.note_workspace === "work");

  if (!project) {
    return null;
  }

  const metadata = project.metadata ?? {};
  return {
    projectId: project.id,
    repoPath: project.repoPath,
    smartGoals: [
      {
        id: "business-context",
        title: metadata.work_smart_goal_business_title ?? DEFAULT_WORK_SMART_GOALS[0].title,
        description:
          metadata.work_smart_goal_business_description ?? DEFAULT_WORK_SMART_GOALS[0].description,
      },
      {
        id: "engineering-learning",
        title: metadata.work_smart_goal_learning_title ?? DEFAULT_WORK_SMART_GOALS[1].title,
        description:
          metadata.work_smart_goal_learning_description ?? DEFAULT_WORK_SMART_GOALS[1].description,
      },
    ],
  };
}

export function normalizeWorkNoteKind(
  noteKind: WorkNoteKind | undefined,
  projectName: string | null | undefined
): WorkNoteKind {
  if (noteKind === "acceptance-criteria" || noteKind === "study" || noteKind === "project") {
    return noteKind;
  }
  return projectName ? "project" : "general";
}

export function normalizeSmartGoalIds(
  smartGoalIds: string[] | undefined,
  noteKind: WorkNoteKind,
  workNotes: WorkNotesConfig
): string[] {
  const allowed = new Set(workNotes.smartGoals.map((goal) => goal.id));
  const normalized = (smartGoalIds ?? []).filter((goalId) => allowed.has(goalId));

  if (normalized.length > 0) {
    return [...new Set(normalized)];
  }

  if (noteKind === "study" && allowed.has("engineering-learning")) {
    return ["engineering-learning"];
  }

  if (noteKind === "acceptance-criteria" && allowed.has("business-context")) {
    return ["business-context"];
  }

  return [];
}

export async function persistWorkNote(params: {
  workNotes: WorkNotesConfig;
  noteId: string;
  title: string;
  content: string;
  noteKind: WorkNoteKind;
  projectName?: string | null;
  smartGoalIds: string[];
  source: AssistantMessageSource;
  sourceContact?: string | null;
  createdAt: string;
  attachments: AssistantAttachment[];
}): Promise<PersistWorkNoteResult> {
  const date = new Date(params.createdAt);
  const dateFolder = date.toISOString().slice(0, 10);
  const noteStem = `${compactTimestamp(date)}-${slugify(params.title).slice(0, 48) || "note"}-${params.noteId.slice(0, 8)}`;
  const projectSlug = slugify(params.projectName ?? "_uncategorized");
  const hasStudyProject = params.noteKind === "study" && Boolean(params.projectName);

  const storageRoot = resolveNoteDirectory(params.workNotes.repoPath, params.noteKind, dateFolder, projectSlug);
  const storagePath = resolve(storageRoot, `${noteStem}.md`);
  const attachmentsDir = resolve(params.workNotes.repoPath, "assets", "attachments", dateFolder, noteStem);

  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(attachmentsDir, { recursive: true });

  const persistedAttachments = await saveAttachments(params.attachments, attachmentsDir, params.workNotes.repoPath);
  const noteBody = renderWorkNoteMarkdown({
    repoPath: params.workNotes.repoPath,
    title: params.title,
    content: params.content,
    noteKind: params.noteKind,
    projectName: params.projectName ?? null,
    smartGoalIds: params.smartGoalIds,
    smartGoals: params.workNotes.smartGoals,
    createdAt: params.createdAt,
    source: params.source,
    sourceContact: params.sourceContact ?? null,
    storagePath,
    attachments: persistedAttachments,
  });

  writeFileSync(storagePath, noteBody, "utf8");

  if (hasStudyProject) {
    ensureStudyProjectIndex(params.workNotes.repoPath, projectSlug, params.projectName ?? "Study Project");
    appendActivityEntry(
      resolve(params.workNotes.repoPath, "study", "projects", projectSlug, "activity.md"),
      storagePath,
      params.title,
      params.noteKind,
      params.createdAt
    );
  }

  if (
    params.noteKind !== "study" &&
    (params.projectName || params.noteKind === "project" || params.noteKind === "acceptance-criteria")
  ) {
    ensureProjectIndex(params.workNotes.repoPath, projectSlug, params.projectName ?? "Uncategorized Work");
    appendActivityEntry(
      resolve(params.workNotes.repoPath, "projects", projectSlug, "activity.md"),
      storagePath,
      params.title,
      params.noteKind,
      params.createdAt
    );
  }

  for (const smartGoalId of params.smartGoalIds) {
    const smartGoal = params.workNotes.smartGoals.find((goal) => goal.id === smartGoalId);
    if (!smartGoal) {
      continue;
    }

    ensureSmartGoalIndex(params.workNotes.repoPath, smartGoal);
    appendActivityEntry(
      resolve(params.workNotes.repoPath, "smart-goals", smartGoal.id, "activity.md"),
      storagePath,
      params.title,
      params.noteKind,
      params.createdAt
    );
  }

  return {
    storagePath,
    attachments: persistedAttachments,
  };
}

function resolveNoteDirectory(
  repoPath: string,
  noteKind: WorkNoteKind,
  dateFolder: string,
  projectSlug: string
): string {
  switch (noteKind) {
    case "study":
      return projectSlug !== "_uncategorized"
        ? resolve(repoPath, "study", "projects", projectSlug, "notes", dateFolder)
        : resolve(repoPath, "study", "notes", dateFolder);
    case "acceptance-criteria":
      return resolve(repoPath, "projects", projectSlug, "acceptance-criteria", dateFolder);
    case "project":
      return resolve(repoPath, "projects", projectSlug, "notes", dateFolder);
    case "general":
    default:
      return resolve(repoPath, "notes", "general", dateFolder);
  }
}

async function saveAttachments(
  attachments: AssistantAttachment[],
  attachmentsDir: string,
  repoPath: string
): Promise<PersistedWorkAttachment[]> {
  const persisted: PersistedWorkAttachment[] = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const originalName = sanitizeFilename(attachment.name ?? `attachment-${index + 1}`);
    const sourceUrl = attachment.url ?? attachment.proxyUrl ?? null;

    if (!sourceUrl) {
      persisted.push({
        originalName,
        sourceUrl: null,
        contentType: attachment.contentType ?? null,
        relativePath: null,
        status: "failed",
        error: "Attachment had no downloadable URL.",
      });
      continue;
    }

    const destinationPath = resolve(attachmentsDir, originalName);
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        persisted.push({
          originalName,
          sourceUrl,
          contentType: attachment.contentType ?? null,
          relativePath: null,
          status: "remote-only",
          error: `Download failed with status ${response.status}.`,
        });
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(destinationPath, bytes);
      persisted.push({
        originalName,
        sourceUrl,
        contentType: attachment.contentType ?? null,
        relativePath: toRepoRelativePath(destinationPath, repoPath),
        status: "saved",
        error: null,
      });
    } catch (error) {
      persisted.push({
        originalName,
        sourceUrl,
        contentType: attachment.contentType ?? null,
        relativePath: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return persisted;
}

function renderWorkNoteMarkdown(params: {
  repoPath: string;
  title: string;
  content: string;
  noteKind: WorkNoteKind;
  projectName: string | null;
  smartGoalIds: string[];
  smartGoals: WorkSmartGoal[];
  createdAt: string;
  source: AssistantMessageSource;
  sourceContact: string | null;
  storagePath: string;
  attachments: PersistedWorkAttachment[];
}): string {
  const smartGoalLabels = params.smartGoalIds.map((goalId) => {
    const goal = params.smartGoals.find((candidate) => candidate.id === goalId);
    return goal ? `${goal.title} (${goal.id})` : goalId;
  });

  const attachmentLines =
    params.attachments.length === 0
      ? ["No attachments captured."]
      : params.attachments.map((attachment) => {
          const link = attachment.relativePath
            ? `[${attachment.originalName}](${relative(dirname(params.storagePath), resolve(params.repoPath, attachment.relativePath)).replace(/\\/g, "/")})`
            : attachment.sourceUrl
              ? `[${attachment.originalName}](${attachment.sourceUrl})`
              : attachment.originalName;
          const suffixParts = [
            attachment.contentType ?? null,
            attachment.status !== "saved" ? attachment.status : null,
            attachment.error,
          ].filter(Boolean);
          return `- ${link}${suffixParts.length > 0 ? ` (${suffixParts.join("; ")})` : ""}`;
        });

  return [
    `# ${params.title}`,
    "",
    "## Metadata",
    `- Created: ${params.createdAt}`,
    `- Source: ${params.source}`,
    `- Source contact: ${params.sourceContact ?? "unknown"}`,
    `- Kind: ${params.noteKind}`,
    `- Project: ${params.projectName ?? "none"}`,
    `- Smart goals: ${smartGoalLabels.length > 0 ? smartGoalLabels.join(", ") : "none"}`,
    "",
    "## Note",
    params.content.trim() || "Attachment note captured from Discord.",
    "",
    "## Attachments",
    ...attachmentLines,
    "",
  ].join("\n");
}

function ensureProjectIndex(repoPath: string, projectSlug: string, projectName: string): void {
  const projectDir = resolve(repoPath, "projects", projectSlug);
  mkdirSync(projectDir, { recursive: true });

  const readmePath = resolve(projectDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      [
        `# ${projectName}`,
        "",
        "This folder holds work notes and ticket materials captured for this project.",
        "",
        "- `notes/`: ongoing project notes",
        "- `acceptance-criteria/`: ticket screenshots and acceptance criteria captures",
        "- `activity.md`: chronological note index",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

function ensureStudyProjectIndex(repoPath: string, projectSlug: string, projectName: string): void {
  const projectDir = resolve(repoPath, "study", "projects", projectSlug);
  mkdirSync(projectDir, { recursive: true });

  const readmePath = resolve(projectDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      [
        `# ${projectName}`,
        "",
        "This folder holds notes, summaries, and captures for a dedicated engineering-learning topic.",
        "",
        "- `notes/`: raw study captures and imported note files",
        "- `activity.md`: chronological index of captured study notes",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

function ensureSmartGoalIndex(repoPath: string, smartGoal: WorkSmartGoal): void {
  const goalDir = resolve(repoPath, "smart-goals", smartGoal.id);
  mkdirSync(goalDir, { recursive: true });

  const readmePath = resolve(goalDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(
      readmePath,
      [
        `# ${smartGoal.title}`,
        "",
        smartGoal.description,
        "",
        "Use `activity.md` as the running index of notes that support this goal.",
        "",
      ].join("\n"),
      "utf8"
    );
  }
}

function appendActivityEntry(
  activityPath: string,
  notePath: string,
  title: string,
  noteKind: WorkNoteKind,
  createdAt: string
): void {
  const activityDir = dirname(activityPath);
  mkdirSync(activityDir, { recursive: true });
  if (!existsSync(activityPath)) {
    writeFileSync(activityPath, "# Activity\n\n", "utf8");
  }

  const linkPath = relative(activityDir, notePath).replace(/\\/g, "/");
  appendFileSync(activityPath, `- ${createdAt}: [${title}](${linkPath}) [${noteKind}]\n`, "utf8");
}

function compactTimestamp(date: Date): string {
  const iso = date.toISOString();
  return iso.slice(0, 19).replace(/[-:T]/g, "");
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "note";
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, "-");
}

function toRepoRelativePath(filePath: string, repoPath: string): string {
  return relative(repoPath, filePath).replace(/\\/g, "/");
}
