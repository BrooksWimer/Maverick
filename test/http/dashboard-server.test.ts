import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantService } from "../../src/assistant/index.js";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "../../src/config/index.js";
import { buildCommandCenterSnapshot } from "../../src/dashboard/index.js";
import { createHttpServer } from "../../src/http/server.js";
import type { OperatorReportArtifactMetadata } from "../../src/orchestrator/status.js";
import { Orchestrator } from "../../src/orchestrator/index.js";
import {
  approvals,
  artifacts,
  assistantCalendarEvents,
  assistantMessages,
  assistantNotes,
  assistantTasks,
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../src/state/index.js";

describe("HTTP command-center dashboard route", () => {
  let tempDir: string;
  let repoPath: string;
  let config: OrchestratorConfig;
  let orchestrator: Orchestrator | null = null;
  let app: Awaited<ReturnType<typeof createHttpServer>> | null = null;
  let previousDashboardToken: string | undefined;

  beforeEach(() => {
    previousDashboardToken = process.env.MAVERICK_DASHBOARD_TOKEN;
    delete process.env.MAVERICK_DASHBOARD_TOKEN;

    tempDir = mkdtempSync(join(tmpdir(), "maverick-dashboard-"));
    repoPath = join(tempDir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "AGENTS.md"), "# Test doctrine", "utf8");
    writeFileSync(join(repoPath, "package.json"), '{"name":"repo"}', "utf8");

    initDatabase(join(tempDir, "orchestrator.db"));

    config = OrchestratorConfigSchema.parse({
      version: 1,
      defaults: {
        executionBackend: {
          type: "mock",
          responseDelay: 0,
        },
      },
      projects: [
        {
          id: "maverick",
          name: "Maverick",
          repoPath,
          workspaceKind: "notes",
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
        {
          id: "netwise",
          name: "Netwise",
          repoPath,
          workspaceKind: "git",
          executionBackend: {
            type: "mock",
            responseDelay: 0,
          },
        },
      ],
      assistant: {
        enabled: true,
        agentProjectId: "maverick",
        timeZone: "America/New_York",
      },
    });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    if (orchestrator) {
      await orchestrator.shutdown();
      orchestrator = null;
    }
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    if (previousDashboardToken === undefined) {
      delete process.env.MAVERICK_DASHBOARD_TOKEN;
    } else {
      process.env.MAVERICK_DASHBOARD_TOKEN = previousDashboardToken;
    }
  });

  it("returns a read-only empty command-center snapshot without assistant data", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/command-center",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, any>;
    expect(payload.assistantAgenda).toBeNull();
    expect(payload.taskSummary.totalActionable).toBe(0);
    expect(payload.todayPlan.focus).toHaveLength(0);
    expect(payload.projectIntelligenceSummaries).toHaveLength(0);
    expect(payload.activeWorkstreams).toHaveLength(0);
    expect(payload.pendingApprovals).toHaveLength(0);
    expect(payload.health.assistantAvailable).toBe(false);
    expect(payload.nextAction).toContain("No urgent");
  });

  it("aggregates assistant tasks, notes, active workstreams, reports, approvals, and events", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const assistant = createAssistantService(config);
    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "command center data",
    });
    assistantTasks.create({
      title: "Review command center",
      details: "Check the dashboard payload.",
      primary_context: "planning",
      status: "open",
    });
    assistantTasks.create({
      title: "Triage inbox",
      details: "Turn inbox capture into scheduled work.",
      primary_context: "work",
      status: "inbox",
    });
    assistantNotes.create({
      title: "Dashboard note",
      content: "Keep the dashboard read-only until auth is in place.",
      note_context: "planning",
      note_kind: "project",
      project_name: "Maverick",
    });
    approvals.create({
      workstream_id: workstream.id,
      type: "command",
      description: "Approve dashboard test action",
      tier: "approval-gated",
    });
    const report: OperatorReportArtifactMetadata = {
      schemaVersion: 1,
      kind: "verification",
      headline: "Dashboard verified",
      summary: "The command-center payload has live orchestration data.",
      filesChanged: ["src/dashboard/service.ts"],
      validation: [
        {
          label: "Unit tests",
          status: "pass",
          detail: "Dashboard tests passed.",
          command: "npm test -- dashboard",
        },
      ],
      remainingRisks: ["Remote auth still needs deployment wiring."],
      nextAction: "Connect the portfolio UI.",
      sourceEvent: "test",
      generatedAt: new Date().toISOString(),
      turnId: null,
    };
    artifacts.create({
      workstream_id: workstream.id,
      type: "operator-report",
      name: "verification-operator-report",
      metadata_json: JSON.stringify(report),
    });

    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
      assistant,
      assistantConfig: config.assistant,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/command-center",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, any>;
    expect(payload.assistantAgenda).not.toBeNull();
    expect(payload.taskSummary.open).toBe(1);
    expect(payload.taskSummary.inbox).toBe(1);
    expect(payload.taskSummary.byContext.planning).toBe(1);
    expect(payload.activeWorkstreams[0].workstreamId).toBe(workstream.id);
    expect(payload.latestReports[0].headline).toBe("Dashboard verified");
    expect(payload.pendingApprovals[0].description).toBe("Approve dashboard test action");
    expect(payload.projectSummaries[0].pendingApprovalCount).toBe(1);
    expect(payload.recentEvents.some((event: { eventType: string }) => event.eventType === "workstream.created")).toBe(true);
    expect(payload.recentNotes[0].title).toBe("Dashboard note");
    expect(payload.todayPlan.planningNotes[0].title).toBe("Dashboard note");
    expect(payload.nextAction).toContain("approval");
  });

  it("joins project intelligence through source assistant messages", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const assistant = createAssistantService(config);

    const taskMessage = assistantMessages.create({
      id: "message-task",
      source: "discord",
      direction: "inbound",
      project_id: "netwise",
      lane_id: "laptop-wifi-scanner",
      thread_id: "thread-astra",
      body: "Astra should be the main focus this week.",
      normalized_body: "astra should be the main focus this week.",
      intent: "task",
      status: "processed",
    });
    const noteMessage = assistantMessages.create({
      id: "message-note",
      source: "discord",
      direction: "inbound",
      project_id: "netwise",
      lane_id: "router-admin-ingestion",
      thread_id: "thread-router",
      body: "Linux is blocked by the router admin flow.",
      normalized_body: "linux is blocked by the router admin flow.",
      intent: "note",
      status: "processed",
    });
    const calendarMessage = assistantMessages.create({
      id: "message-calendar",
      source: "discord",
      direction: "inbound",
      project_id: "netwise",
      lane_id: "laptop-wifi-scanner",
      thread_id: "thread-astra",
      body: "Review Astra this afternoon.",
      normalized_body: "review astra this afternoon.",
      intent: "calendar",
      status: "processed",
    });
    assistantMessages.create({
      id: "message-unresolved",
      source: "discord",
      direction: "inbound",
      project_id: "netwise",
      lane_id: "mobile-wifi-scanner",
      thread_id: "thread-mobile",
      body: "Need to revisit Android Wi-Fi permission behavior.",
      normalized_body: "need to revisit android wi-fi permission behavior.",
      status: "received",
    });
    assistantTasks.create({
      id: "task-astra",
      message_id: taskMessage.id,
      title: "Focus on Astra this week",
      details: "Astra should be the main focus this week.",
      primary_context: "work",
      status: "open",
    });
    assistantNotes.create({
      id: "note-router",
      message_id: noteMessage.id,
      title: "Router Linux blocker",
      content: "Need to look into why Linux is being blocked.",
      note_context: "work",
      note_kind: "project",
      storage_path: "/srv/maverick/repos/work/notes/general/router-linux-blocker.md",
    });
    assistantCalendarEvents.create({
      id: "calendar-astra",
      message_id: calendarMessage.id,
      title: "Review Astra",
      details: "Look at the laptop scanner path.",
      starts_at: "2026-05-04T15:00:00-04:00",
      ends_at: "2026-05-04T15:30:00-04:00",
      timezone: "America/New_York",
      sync_status: "synced",
    });

    const snapshot = buildCommandCenterSnapshot({
      orchestrator,
      assistant,
      now: new Date("2026-05-04T12:00:00-04:00"),
    });
    const netwiseSummary = snapshot.projectIntelligenceSummaries.find((summary) => summary.projectId === "netwise");

    expect(netwiseSummary?.headline).toContain("action item");
    expect(netwiseSummary?.keyUpdates[0]).toContain("Router Linux blocker");
    expect(netwiseSummary?.actionItems).toContain("Focus on Astra this week");
    expect(netwiseSummary?.unresolvedCaptureCount).toBe(1);
    expect(snapshot.todayPlan.focus[0].title).toBe("Focus on Astra this week");
    expect(snapshot.todayPlan.calendarEvents[0].title).toBe("Review Astra");

    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
      assistant,
      assistantConfig: config.assistant,
    });

    const detailResponse = await app.inject({
      method: "GET",
      url: "/api/dashboard/projects/netwise",
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as Record<string, any>;
    expect(detail.notes[0].storagePath).toContain("router-linux-blocker.md");
    expect(detail.notes[0].sourceProjectId).toBe("netwise");
    expect(detail.notes[0].evidenceLinks.some((link: { kind: string }) => link.kind === "note-file")).toBe(true);
    expect(detail.lanes.some((lane: { laneId: string }) => lane.laneId === "laptop-wifi-scanner")).toBe(true);
    expect(detail.unresolvedCaptures[0].body).toContain("Android Wi-Fi");
  });

  it("protects dashboard routes when a dashboard token is configured", async () => {
    process.env.MAVERICK_DASHBOARD_TOKEN = "dashboard-secret";
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
    });

    const unauthorizedSnapshot = await app.inject({
      method: "GET",
      url: "/api/dashboard/command-center",
    });
    expect(unauthorizedSnapshot.statusCode).toBe(401);

    const unauthorizedProject = await app.inject({
      method: "GET",
      url: "/api/dashboard/projects/netwise",
    });
    expect(unauthorizedProject.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "GET",
      url: "/api/dashboard/command-center",
      headers: {
        authorization: "Bearer dashboard-secret",
      },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("flags stale active workstreams", async () => {
    orchestrator = new Orchestrator(config);
    await orchestrator.initialize();
    const workstream = await orchestrator.createWorkstream({
      projectId: "maverick",
      name: "quiet workstream",
    });
    getDatabase()
      .prepare("UPDATE workstreams SET last_activity_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(), workstream.id);

    app = await createHttpServer(orchestrator, {
      host: "127.0.0.1",
      port: 0,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/dashboard/command-center",
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, any>;
    expect(payload.health.staleWorkstreamCount).toBe(1);
    expect(payload.nextAction).toContain("stale workstream");
  });
});
