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

  // --- Projects ---

  app.get("/api/projects/:projectId/status", async (req) => {
    const { projectId } = req.params as { projectId: string };
    return orchestrator.getProjectStatus(projectId);
  });

  // --- Workstreams ---

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

    app.get("/api/assistant/calendar", async (req) => {
      const { limit } = req.query as { limit?: string };
      return options.assistant!.listCalendarEvents(limit ? parseInt(limit, 10) : undefined);
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

function resolveWebhookUrl(path: string, host: string | undefined, protocol: string): string {
  const explicit = process.env.ASSISTANT_TWILIO_WEBHOOK_URL;
  if (explicit) {
    return explicit;
  }

  const resolvedHost = host ?? "localhost";
  return `${protocol}://${resolvedHost}${path}`;
}
