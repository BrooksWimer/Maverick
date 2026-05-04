/**
 * HTTP API server: local interface for the orchestrator.
 *
 * This gives you a way to interact with the system before Discord is wired up,
 * and also serves as the health/status endpoint for monitoring.
 */
import Fastify from "fastify";
import { createLogger } from "../logger.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AssistantConfig } from "../config/index.js";
import type { AssistantService } from "../assistant/index.js";
import { validateTwilioSignature } from "../assistant/providers/sms.js";
import {
  buildCommandCenterProjectDetail,
  buildCommandCenterSnapshot,
} from "../dashboard/index.js";
import { getStateBackendMode, invokeLocalStateOperation } from "../state/index.js";

const log = createLogger("http");

export async function createHttpServer(
  orchestrator: Orchestrator,
  options: {
    port: number;
    host: string;
    assistant?: AssistantService | null;
    assistantConfig?: AssistantConfig;
  }
) {
  const app = Fastify({ logger: false, trustProxy: true });

  app.addContentTypeParser(
    /^application\/x-www-form-urlencoded(?:;.*)?$/i,
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const payload = typeof body === "string" ? body : body.toString("utf8");
        done(null, Object.fromEntries(new URLSearchParams(payload)));
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );

  // --- Health ---

  app.get("/health", async () => orchestrator.getHealthStatus());

  // --- Dashboard ---

  app.options("/api/dashboard/command-center", async (req, reply) => {
    applyDashboardCors(req, reply);
    reply.code(204);
    return null;
  });

  app.get("/api/dashboard/command-center", async (req, reply) => {
    applyDashboardCors(req, reply);
    if (!isDashboardAuthorized(req)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    return buildCommandCenterSnapshot({
      orchestrator,
      assistant: options.assistant ?? null,
    });
  });

  app.options("/api/dashboard/projects/:projectId", async (req, reply) => {
    applyDashboardCors(req, reply);
    reply.code(204);
    return null;
  });

  app.get("/api/dashboard/projects/:projectId", async (req, reply) => {
    applyDashboardCors(req, reply);
    if (!isDashboardAuthorized(req)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }

    const { projectId } = req.params as { projectId: string };
    const detail = buildCommandCenterProjectDetail({
      orchestrator,
      assistant: options.assistant ?? null,
      projectId,
    });
    if (!detail) {
      reply.code(404);
      return { error: "Project not found" };
    }
    return detail;
  });

  // --- Internal state RPC ---

  const stateToken = process.env.MAVERICK_STATE_TOKEN?.trim();
  if (stateToken && getStateBackendMode() === "sqlite") {
    app.post("/internal/state/operation", async (req, reply) => {
      const authorization = req.headers.authorization;
      if (authorization !== `Bearer ${stateToken}`) {
        reply.code(401);
        return { ok: false, error: "Unauthorized" };
      }

      const body = req.body as {
        repository?: unknown;
        method?: unknown;
        args?: unknown;
      };
      if (typeof body.repository !== "string" || typeof body.method !== "string") {
        reply.code(400);
        return { ok: false, error: "Missing repository or method." };
      }

      try {
        const result = invokeLocalStateOperation(
          body.repository,
          body.method,
          Array.isArray(body.args) ? body.args : [],
        );
        return { ok: true, result };
      } catch (error) {
        reply.code(500);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
  } else if (getStateBackendMode() === "sqlite") {
    log.warn("Internal state API disabled because MAVERICK_STATE_TOKEN is not set");
  }

  // --- Projects ---

  app.get("/api/projects/:projectId/status", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return orchestrator.getProjectStatus(projectId);
  });

  // --- Workstreams ---

  app.get("/api/maverick/audit", async (req) => {
    const { scope } = req.query as { scope?: "git" | "discord" | "state" | "all" };
    return orchestrator.getAuditReport(scope ?? "all");
  });

  app.get("/api/workstreams", async () => {
    return orchestrator.listActiveWorkstreams();
  });

  app.get("/api/workstreams/:id", async (req) => {
    const { id } = req.params as { id: string };
    const ws = orchestrator.getWorkstream(id);
    if (!ws) {
      return { error: "Workstream not found" };
    }
    return ws;
  });

  app.get("/api/workstreams/:id/status", async (req) => {
    const { id } = req.params as { id: string };
    const snapshot = orchestrator.getWorkstreamStatusSnapshot(id);
    if (!snapshot) {
      return { error: "Workstream not found" };
    }
    return snapshot;
  });

  app.post("/api/workstreams", async (req) => {
    const body = req.body as { projectId: string; name: string; description?: string; epicId?: string };
    const ws = await orchestrator.createWorkstream({
      projectId: body.projectId,
      name: body.name,
      description: body.description,
      epicId: body.epicId,
    });
    return ws;
  });

  app.post("/api/workstreams/:id/dispatch", async (req) => {
    const { id } = req.params as { id: string };
    const { instruction } = req.body as { instruction: string };
    const result = await orchestrator.dispatch(id, instruction);
    return result;
  });

  app.post("/api/workstreams/:id/steer", async (req) => {
    const { id } = req.params as { id: string };
    const { instruction } = req.body as { instruction: string };
    await orchestrator.steer(id, instruction);
    return { ok: true };
  });

  app.post("/api/workstreams/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    await orchestrator.cancel(id);
    return { ok: true };
  });

  app.post("/api/workstreams/:id/archive", async (req) => {
    const { id } = req.params as { id: string };
    const { archivedBy } = (req.body as { archivedBy?: string }) ?? {};
    return orchestrator.archive(id, archivedBy);
  });

  app.post("/api/workstreams/:id/transition", async (req) => {
    const { id } = req.params as { id: string };
    const { trigger } = req.body as { trigger: string };
    const newState = await orchestrator.transitionState(id, trigger);
    return { state: newState };
  });

  app.post("/api/workstreams/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const { target } = (req.body as { target?: string }) ?? {};
    const result = await orchestrator.review(id, target);
    return result;
  });

  app.post("/api/workstreams/:id/verify", async (req) => {
    const { id } = req.params as { id: string };
    return orchestrator.verify(id, {
      trigger: "manual",
    });
  });

  app.post("/api/workstreams/:id/finish", async (req) => {
    const { id } = req.params as { id: string };
    const { finishedBy } = (req.body as { finishedBy?: string }) ?? {};
    return orchestrator.finishWorkstream(id, {
      trigger: "manual",
      finishedBy: finishedBy ?? "http",
    });
  });

  app.post("/api/projects/:projectId/lanes/:laneId/verify", async (req) => {
    const { projectId, laneId } = req.params as { projectId: string; laneId: string };
    return orchestrator.verifyLane(projectId, laneId);
  });

  app.post("/api/projects/:projectId/lanes/:laneId/promote", async (req) => {
    const { projectId, laneId } = req.params as { projectId: string; laneId: string };
    const { promotedBy } = (req.body as { promotedBy?: string }) ?? {};
    return orchestrator.promoteLane(projectId, laneId, promotedBy ?? "http");
  });

  // --- Turns ---

  app.get("/api/workstreams/:id/turns", async (req) => {
    const { id } = req.params as { id: string };
    return orchestrator.getWorkstreamTurns(id);
  });

  // --- Approvals ---

  app.get("/api/approvals", async () => {
    return orchestrator.getPendingApprovals();
  });

  app.post("/api/approvals/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const { approved, decidedBy } = req.body as { approved: boolean; decidedBy?: string };
    return orchestrator.resolveApproval(id, approved, decidedBy);
  });

  // --- Events ---

  app.get("/api/events", async (req) => {
    const { limit } = req.query as { limit?: string };
    return orchestrator.getRecentEvents(limit ? parseInt(limit) : undefined);
  });

  // --- Assistant ---

  if (options.assistant?.isEnabled()) {
    app.get("/api/assistant/messages", async (req) => {
      const { limit } = req.query as { limit?: string };
      return options.assistant!.listMessages(limit ? parseInt(limit, 10) : undefined);
    });

    app.get("/api/assistant/notes", async (req) => {
      const { limit } = req.query as { limit?: string };
      return options.assistant!.listNotes(limit ? parseInt(limit, 10) : undefined);
    });

    app.get("/api/assistant/reminders", async (req) => {
      const { limit } = req.query as { limit?: string };
      return options.assistant!.listReminders(limit ? parseInt(limit, 10) : undefined);
    });

    app.get("/api/assistant/tasks", async (req) => {
      const { limit, status, context } = req.query as { limit?: string; status?: string; context?: string };
      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      if (status === "inbox") {
        return options.assistant!.listInbox(parsedLimit, context as
          | "work"
          | "personal"
          | "home"
          | "errands"
          | "health"
          | "planning"
          | undefined);
      }
      return options.assistant!.listTasks(parsedLimit);
    });

    app.get("/api/assistant/calendar", async (req) => {
      const { limit } = req.query as { limit?: string };
      return options.assistant!.listCalendarEvents(limit ? parseInt(limit, 10) : undefined);
    });

    app.get("/api/assistant/agenda", async (req) => {
      const { context } = req.query as { context?: string };
      return options.assistant!.getAgenda(context as
        | "work"
        | "personal"
        | "home"
        | "errands"
        | "health"
        | "planning"
        | undefined);
    });

    app.get("/api/assistant/search", async (req) => {
      const { q, context, limit } = req.query as { q?: string; context?: string; limit?: string };
      if (!q) {
        return { error: "Missing q parameter" };
      }

      return options.assistant!.search(q, {
        context: context as
          | "work"
          | "personal"
          | "home"
          | "errands"
          | "health"
          | "planning"
          | undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });
    });

    app.get("/api/assistant/models", async (req) => {
      const { channelId } = req.query as { channelId?: string };
      return options.assistant!.getModelState({
        source: "discord",
        channelId: channelId ?? null,
      });
    });

    app.post("/api/assistant/messages", async (req) => {
      const body = req.body as {
        body: string;
        from?: string;
        source?: "sms" | "api";
        attachments?: Array<Record<string, unknown>>;
      };
      const result = await options.assistant!.processIncomingMessage({
        source: body.source ?? "api",
        body: body.body,
        from: body.from ?? null,
        attachments: Array.isArray(body.attachments)
          ? body.attachments.map((attachment) => ({
              id: typeof attachment.id === "string" ? attachment.id : null,
              url: typeof attachment.url === "string" ? attachment.url : null,
              proxyUrl: typeof attachment.proxyUrl === "string" ? attachment.proxyUrl : null,
              name: typeof attachment.name === "string" ? attachment.name : null,
              contentType: typeof attachment.contentType === "string" ? attachment.contentType : null,
              size: typeof attachment.size === "number" ? attachment.size : null,
              width: typeof attachment.width === "number" ? attachment.width : null,
              height: typeof attachment.height === "number" ? attachment.height : null,
            }))
          : [],
        metadata: {
          route: "/api/assistant/messages",
        },
      });
      return result;
    });

    app.post("/api/assistant/tasks/:id/done", async (req) => {
      const { id } = req.params as { id: string };
      return options.assistant!.completeTask(id);
    });

    app.post("/api/assistant/tasks/:id/snooze", async (req) => {
      const { id } = req.params as { id: string };
      const { when } = req.body as { when: string };
      return options.assistant!.snoozeTask(id, when);
    });

    app.post("/api/assistant/items/:id/retag", async (req) => {
      const { id } = req.params as { id: string };
      const { context } = req.body as {
        context: "work" | "personal" | "home" | "errands" | "health" | "planning";
      };
      return options.assistant!.retagItem(id, context);
    });

    app.post("/api/assistant/models", async (req) => {
      const body = req.body as {
        scope: "global" | "discord-channel";
        scopeId?: string;
        feature: "classification" | "query" | "summary" | "planning" | "verification" | "review";
        profile: "cheap" | "default" | "deep";
      };
      const scopeId = body.scope === "global" ? "global" : body.scopeId ?? "";
      if (!scopeId) {
        return { error: "Missing scopeId" };
      }

      return options.assistant!.setModelOverride({
        scope: body.scope,
        scopeId,
        feature: body.feature,
        profile: body.profile,
      });
    });

    app.post("/api/assistant/reminders/process-due", async () => {
      return options.assistant!.processDueReminders();
    });

    app.post("/webhooks/twilio/sms", async (req, reply) => {
      const payload = req.body as Record<string, string | undefined>;
      const signature = req.headers["x-twilio-signature"];
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (
        options.assistantConfig?.sms.requireSignatureValidation &&
        authToken &&
        !validateTwilioSignature(
          authToken,
          resolveWebhookUrl(req.url, req.headers.host, req.protocol),
          payload,
          typeof signature === "string" ? signature : Array.isArray(signature) ? signature[0] : null
        )
      ) {
        reply.code(401).type("text/plain");
        return "Invalid Twilio signature";
      }

      const result = await options.assistant!.processIncomingMessage({
        source: "sms",
        body: payload.Body ?? "",
        from: payload.From ?? null,
        metadata: {
          route: "/webhooks/twilio/sms",
          to: payload.To ?? null,
          messageSid: payload.MessageSid ?? null,
          accountSid: payload.AccountSid ?? null,
        },
      });

      reply.type("text/xml; charset=utf-8");
      return renderTwimlMessage(result.reply);
    });
  }

  // --- Start ---

  await app.listen({ port: options.port, host: options.host });
  log.info({ port: options.port, host: options.host }, "HTTP server listening");

  return app;
}

function renderTwimlMessage(message: string): string {
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function applyDashboardCors(
  req: { headers: { origin?: string | string[] } },
  reply: {
    header: (name: string, value: string) => unknown;
  }
): void {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const allowedOrigin = resolveDashboardAllowedOrigin(origin);
  if (allowedOrigin) {
    reply.header("Access-Control-Allow-Origin", allowedOrigin);
    reply.header("Vary", "Origin");
  }
  reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "authorization, content-type");
  reply.header("Access-Control-Max-Age", "86400");
}

function resolveDashboardAllowedOrigin(requestOrigin: string | undefined): string | null {
  const configured = process.env.MAVERICK_DASHBOARD_ALLOWED_ORIGIN?.trim();
  if (!configured || configured === "*") {
    return "*";
  }

  const allowed = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    return null;
  }
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return requestOrigin;
  }
  return allowed[0] ?? null;
}

function isDashboardAuthorized(req: { headers: { authorization?: string | string[] } }): boolean {
  const token = process.env.MAVERICK_DASHBOARD_TOKEN?.trim();
  if (!token) {
    return true;
  }

  const authorization = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  return authorization === `Bearer ${token}`;
}

function resolveWebhookUrl(path: string, host: string | undefined, protocol: string): string {
  const explicit = process.env.ASSISTANT_TWILIO_WEBHOOK_URL;
  if (explicit) {
    return explicit;
  }

  const resolvedHost = host ?? "localhost";
  return `${protocol}://${resolvedHost}${path}`;
}
