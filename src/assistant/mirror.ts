import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createLogger } from "../logger.js";
import type { OrchestratorConfig } from "../config/index.js";
import {
  artifacts,
  assistantCalendarEvents,
  assistantNotes,
  assistantReminders,
  assistantTasks,
  events,
  workstreams,
} from "../state/index.js";
import { normalizeStoredContext, renderAgendaMarkdown, renderInboxMarkdown } from "./render.js";
import { refreshGoogleAccessToken } from "./providers/google-auth.js";

const log = createLogger("assistant:mirror");

type MirrorOptions = {
  now?: () => Date;
};

export class AssistantDriveMirrorService {
  private readonly now: () => Date;
  private syncTimer: NodeJS.Timeout | null = null;
  private syncPromise: Promise<void> | null = null;

  constructor(
    private readonly config: OrchestratorConfig,
    options: MirrorOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.config.assistant.drive.enabled) {
      return;
    }

    this.queueSync("startup");
  }

  shutdown(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  queueSync(reason: string): void {
    if (!this.config.assistant.drive.enabled || !this.config.assistant.drive.syncOnChange) {
      return;
    }

    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncAll().catch((error) => {
        log.warn({ err: error, reason }, "Assistant mirror sync failed");
      });
    }, 500);
    this.syncTimer.unref?.();
  }

  async syncAll(): Promise<void> {
    if (!this.config.assistant.drive.enabled) {
      return;
    }

    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.syncAllInternal();
    try {
      await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  private async syncAllInternal(): Promise<void> {
    const exportRoot = resolve(process.cwd(), this.config.assistant.drive.exportPath);
    mkdirSync(exportRoot, { recursive: true });

    this.writeLifeOsDocs(exportRoot);
    this.writeProjectDocs(exportRoot);
    this.writeRawArchive(exportRoot);

    if (this.config.assistant.drive.provider === "google") {
      await this.syncExportTreeToGoogleDrive(exportRoot);
    }
  }

  private writeLifeOsDocs(exportRoot: string): void {
    const generatedAt = this.now().toISOString();
    const agenda = buildAgendaSnapshot(this.config.assistant.timeZone, generatedAt);
    const inbox = agenda.inboxTasks;
    this.writeText(exportRoot, join("Life OS", "Agenda.md"), renderAgendaMarkdown(agenda));
    this.writeText(exportRoot, join("Life OS", "Inbox.md"), renderInboxMarkdown(inbox, this.config.assistant.timeZone, generatedAt));
  }

  private writeProjectDocs(exportRoot: string): void {
    const projectIndexLines = ["# Projects Index", ""];

    for (const project of this.config.projects) {
      const projectRoot = join(exportRoot, "Projects", project.id);
      mkdirSync(projectRoot, { recursive: true });
      const projectWorkstreams = workstreams.listByProject(project.id);
      const active = projectWorkstreams.filter((workstream) => workstream.state !== "done");
      const summaryLines = [
        `# ${project.name}`,
        "",
        `Project ID: ${project.id}`,
        `Repo Path: ${project.repoPath}`,
        `Active Workstreams: ${active.length}`,
        "",
        "## Workstreams",
      ];

      if (projectWorkstreams.length === 0) {
        summaryLines.push("- No workstreams yet.");
      } else {
        for (const workstream of projectWorkstreams.slice(0, 10)) {
          const latestArtifact = artifacts.getLatestByWorkstream(workstream.id, "operator-report");
          const metadata = safeJson(latestArtifact?.metadata_json ?? null);
          const latestSummary = typeof metadata.summary === "string" ? metadata.summary : workstream.summary ?? workstream.current_goal ?? "";
          summaryLines.push(`- ${workstream.name} [${workstream.state}]${latestSummary ? `: ${latestSummary}` : ""}`);
        }
      }

      this.writeText(exportRoot, join("Projects", project.id, "Summary.md"), `${summaryLines.join("\n")}\n`);
      projectIndexLines.push(`- [${project.name}](./${project.id}/Summary.md)`);
      this.copyRepoDocs(project.repoPath, join(exportRoot, "Projects", project.id, "repo-docs"));
      this.copySelectedCodeArtifacts(project, join(exportRoot, "Projects", project.id, "selected-artifacts"));
    }

    this.writeText(exportRoot, join("Projects", "Index.md"), `${projectIndexLines.join("\n")}\n`);
  }

  private writeRawArchive(exportRoot: string): void {
    for (const note of assistantNotes.listRecent(300)) {
      const content = [
        `# ${note.title}`,
        "",
        `Created: ${note.created_at}`,
        `Context: ${note.note_context}`,
        note.project_name ? `Project: ${note.project_name}` : null,
        "",
        note.content,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      this.writeText(exportRoot, join("raw", "notes", `${note.id}.md`), `${content}\n`);
    }

    for (const task of assistantTasks.listRecent(300)) {
      const content = [
        `# ${task.title}`,
        "",
        `Created: ${task.created_at}`,
        `Updated: ${task.updated_at}`,
        `Context: ${task.primary_context}`,
        `Status: ${task.status}`,
        task.due_at ? `Due: ${task.due_at}` : null,
        task.scheduled_for ? `Scheduled: ${task.scheduled_for}` : null,
        "",
        task.details,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      this.writeText(exportRoot, join("raw", "tasks", `${task.id}.md`), `${content}\n`);
    }

    for (const reminder of assistantReminders.listRecent(200)) {
      const content = [
        `# Reminder`,
        "",
        `Created: ${reminder.created_at}`,
        `Remind At: ${reminder.remind_at}`,
        `Status: ${reminder.status}`,
        "",
        reminder.body,
      ].join("\n");
      this.writeText(exportRoot, join("raw", "reminders", `${reminder.id}.md`), `${content}\n`);
    }

    for (const event of assistantCalendarEvents.listRecent(200)) {
      const content = [
        `# ${event.title}`,
        "",
        `Starts: ${event.starts_at}`,
        event.ends_at ? `Ends: ${event.ends_at}` : null,
        `Sync: ${event.sync_status}`,
        event.location ? `Location: ${event.location}` : null,
        "",
        event.details ?? "",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      this.writeText(exportRoot, join("raw", "calendar", `${event.id}.md`), `${content}\n`);
    }

    for (const artifact of artifacts.listRecent(200, "operator-report")) {
      const metadata = safeJson(artifact.metadata_json);
      const title = typeof metadata.headline === "string" ? metadata.headline : artifact.name;
      const content = [
        `# ${title}`,
        "",
        `Created: ${artifact.created_at}`,
        `Workstream: ${artifact.workstream_id}`,
        typeof metadata.summary === "string" ? `Summary: ${metadata.summary}` : null,
        "",
        artifact.content ?? "",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      this.writeText(exportRoot, join("raw", "workstream-reports", `${artifact.id}.md`), `${content}\n`);
    }

    for (const eventRow of [...events.listByType("brief.generated", 50), ...events.listByType("daily-brief.generated", 50)]) {
      const payload = safeJson(eventRow.payload_json);
      const storagePath = typeof payload.storagePath === "string"
        ? payload.storagePath
        : typeof payload.artifactPath === "string"
          ? payload.artifactPath
          : null;
      if (!storagePath || !existsSync(storagePath)) {
        continue;
      }

      this.copyFile(storagePath, join(exportRoot, "raw", "briefs", basename(storagePath)));
    }
  }

  private copyRepoDocs(repoPath: string, destinationRoot: string): void {
    const candidatePaths = new Set<string>();

    for (const entry of readdirSync(repoPath, { withFileTypes: true })) {
      if (entry.isFile() && /^(README|AGENTS)(\..+)?$/i.test(entry.name)) {
        candidatePaths.add(join(repoPath, entry.name));
      }
    }

    const docsDir = join(repoPath, "docs");
    if (existsSync(docsDir)) {
      for (const path of collectMarkdownFiles(docsDir).slice(0, 20)) {
        candidatePaths.add(path);
      }
    }

    for (const sourcePath of candidatePaths) {
      const rel = relative(repoPath, sourcePath);
      this.copyFile(sourcePath, join(destinationRoot, rel));
    }
  }

  private copySelectedCodeArtifacts(
    project: OrchestratorConfig["projects"][number],
    destinationRoot: string
  ): void {
    const projectWorkstreams = workstreams.listByProject(project.id);
    for (const workstream of projectWorkstreams.slice(0, 10)) {
      const artifact = artifacts.getLatestByWorkstream(workstream.id, "operator-report");
      const metadata = safeJson(artifact?.metadata_json ?? null);
      const filesChanged = Array.isArray(metadata.filesChanged)
        ? metadata.filesChanged.filter((entry): entry is string => typeof entry === "string")
        : [];

      for (const changedFile of filesChanged.slice(0, 20)) {
        const absolutePath = resolve(workstream.cwd ?? project.repoPath, changedFile);
        if (!absolutePath.startsWith(resolve(project.repoPath)) || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
          continue;
        }

        this.copyFile(absolutePath, join(destinationRoot, workstream.id, changedFile));
      }
    }
  }

  private async syncExportTreeToGoogleDrive(exportRoot: string): Promise<void> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const rootFolderId = this.config.assistant.drive.googleRootFolderId ?? process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? null;

    if (!clientId || !clientSecret || !refreshToken || !rootFolderId) {
      log.warn("Google Drive mirror is enabled but OAuth credentials or root folder id are missing; local export still succeeded");
      return;
    }

    const accessToken = await refreshGoogleAccessToken(clientId, clientSecret, refreshToken);
    const files = walkFiles(exportRoot);
    const folderCache = new Map<string, string>([[".", rootFolderId]]);

    for (const filePath of files) {
      const relativePath = relative(exportRoot, filePath).replace(/\\/g, "/");
      const parts = relativePath.split("/");
      const fileName = parts.pop();
      if (!fileName) {
        continue;
      }

      let parentKey = ".";
      let parentId = rootFolderId;
      for (const segment of parts) {
        const folderKey = parentKey === "." ? segment : `${parentKey}/${segment}`;
        const cached = folderCache.get(folderKey);
        if (cached) {
          parentId = cached;
          parentKey = folderKey;
          continue;
        }

        parentId = await this.findOrCreateDriveFolder(accessToken, parentId, segment);
        folderCache.set(folderKey, parentId);
        parentKey = folderKey;
      }

      await this.upsertDriveFile(accessToken, parentId, fileName, filePath);
    }
  }

  private async findOrCreateDriveFolder(accessToken: string, parentId: string, name: string): Promise<string> {
    const escapedName = name.replace(/'/g, "\\'");
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and '${parentId}' in parents and trashed=false`)}&fields=files(id,name)&spaces=drive`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const payload = (await response.json()) as { files?: Array<{ id?: string }> };
    const existingId = payload.files?.[0]?.id;
    if (response.ok && existingId) {
      return existingId;
    }

    const createResponse = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    });
    const createPayload = (await createResponse.json()) as { id?: string };
    if (!createResponse.ok || !createPayload.id) {
      throw new Error(`Failed to create Drive folder ${name}`);
    }
    return createPayload.id;
  }

  private async upsertDriveFile(accessToken: string, parentId: string, fileName: string, filePath: string): Promise<void> {
    const escapedName = fileName.replace(/'/g, "\\'");
    const findResponse = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`name='${escapedName}' and '${parentId}' in parents and trashed=false`)}&fields=files(id,name)&spaces=drive`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const findPayload = (await findResponse.json()) as { files?: Array<{ id?: string }> };
    const existingId = findPayload.files?.[0]?.id;
    const content = readFileSync(filePath);
    const boundary = `maverick-${Date.now()}`;
    const metadata = JSON.stringify({
      name: fileName,
      parents: [parentId],
    });
    const mimeType = fileName.endsWith(".md") ? "text/markdown" : "text/plain";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const method = existingId ? "PATCH" : "POST";
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload Drive file ${fileName}`);
    }
  }

  private writeText(exportRoot: string, relativePath: string, content: string): void {
    const absolutePath = join(exportRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }

  private copyFile(sourcePath: string, destinationPath: string): void {
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
  }
}

function buildAgendaSnapshot(timeZone: string, generatedAt: string) {
  const now = new Date(generatedAt);
  const activeTasks = assistantTasks.listRecent(500)
    .filter((task) => !["done", "archived"].includes(task.status))
    .map((task) => ({
      id: task.id,
      title: task.title,
      details: task.details,
      primaryContext: normalizeStoredContext(task.primary_context),
      status: task.status as "inbox" | "open" | "scheduled" | "done" | "archived",
      dueAt: task.due_at,
      scheduledFor: task.scheduled_for,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      completedAt: task.completed_at,
      noteId: task.note_id,
      reminderId: task.reminder_id,
      calendarEventId: task.calendar_event_id,
    }));
  const referenceIso = generatedAt;

  return {
    generatedAt,
    timeZone,
    overdueTasks: activeTasks.filter((task) => task.dueAt && task.dueAt < referenceIso && task.status !== "scheduled"),
    dueTodayTasks: activeTasks.filter((task) => task.dueAt && task.dueAt >= referenceIso && sameLocalDay(task.dueAt, now, timeZone)),
    openTasks: activeTasks.filter((task) => task.status === "open"),
    scheduledTasks: activeTasks.filter((task) => task.status === "scheduled" && (task.scheduledFor ?? task.dueAt ?? "") >= referenceIso),
    inboxTasks: activeTasks.filter((task) => task.status === "inbox"),
    upcomingCalendar: assistantCalendarEvents.listUpcoming(referenceIso, 20).map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      timeZone: event.timezone,
      location: event.location,
      syncStatus: event.sync_status,
      recurrenceRule: event.recurrence_rule ?? null,
    })),
    activeWorkstreams: workstreams.listActive().slice(0, 6).map((workstream) => ({
      id: workstream.id,
      name: workstream.name,
      projectId: workstream.project_id,
      state: workstream.state,
      currentGoal: workstream.current_goal,
      summary: workstream.summary,
      updatedAt: workstream.last_activity_at,
    })),
    nextAction: buildNextAction(activeTasks, timeZone),
  };
}

function buildNextAction(tasks: Array<{ title: string; status: string; dueAt: string | null }>, timeZone: string): string {
  const overdue = tasks.find((task) => task.dueAt && task.dueAt < new Date().toISOString() && task.status !== "scheduled");
  if (overdue) {
    return `Start with overdue task "${overdue.title}".`;
  }

  const inbox = tasks.find((task) => task.status === "inbox");
  if (inbox) {
    return `Triage inbox item "${inbox.title}".`;
  }

  const open = tasks.find((task) => task.status === "open");
  if (open) {
    return `Resume open task "${open.title}".`;
  }

  const scheduled = tasks.find((task) => task.status === "scheduled" && task.dueAt);
  if (scheduled) {
    return `Prepare for scheduled task "${scheduled.title}" due ${scheduled.dueAt}.`;
  }

  return "No urgent items are queued.";
}

function sameLocalDay(value: string, referenceTime: Date, timeZone: string): boolean {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date(value)) === formatter.format(referenceTime);
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function collectMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(absolute));
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      results.push(absolute);
    }
  }
  return results;
}

function walkFiles(root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolute));
      continue;
    }
    if (entry.isFile()) {
      results.push(absolute);
    }
  }
  return results;
}
