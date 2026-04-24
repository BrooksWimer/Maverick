/**
 * Codex Orchestrator entry point.
 *
 * Starts the orchestrator, HTTP server, and (optionally) Discord bot.
 * Handles graceful shutdown.
 */
import { loadEnvironment } from "./config/env.js";
import { loadConfig } from "./config/index.js";
import { initDatabase, closeDatabase } from "./state/index.js";
import { Orchestrator } from "./orchestrator/index.js";
import { createHttpServer } from "./http/server.js";
import { createDiscordBot } from "./discord/index.js";
import { createLogger } from "./logger.js";
import { createAssistantMirrorService, createAssistantService } from "./assistant/index.js";
import { DailyBriefService } from "./daily-brief/index.js";
import { eventBus } from "./orchestrator/event-bus.js";

loadEnvironment();

const log = createLogger("main");

function isRecoverableHttpStartupError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown };
  return candidate.code === "EADDRINUSE";
}

async function main() {
  log.info("Starting Codex Orchestrator");

  // Load config
  const configArgIndex = process.argv.findIndex((arg) => arg === "--config");
  const configPath =
    process.argv.find((arg) => arg.startsWith("--config="))?.split("=")[1] ??
    (configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined);
  const config = loadConfig(configPath);

  // Initialize database
  initDatabase(process.env.DATABASE_PATH);

  // Initialize orchestrator
  const orchestrator = new Orchestrator(config);
  await orchestrator.initialize();

  const assistantMirror = createAssistantMirrorService(config);
  assistantMirror.start();
  const assistant = createAssistantService(config, {
    mirror: assistantMirror,
  });
  assistant.start();
  const dailyBrief = new DailyBriefService(orchestrator, config);
  dailyBrief.start();

  eventBus.on("turn.completed", () => assistantMirror.queueSync("turn.completed"));
  eventBus.on("plan.generated", () => assistantMirror.queueSync("plan.generated"));
  eventBus.on("review.completed", () => assistantMirror.queueSync("review.completed"));
  eventBus.on("verification.completed", () => assistantMirror.queueSync("verification.completed"));
  eventBus.on("brief.generated", () => assistantMirror.queueSync("brief.generated"));

  // Start HTTP server
  let httpServer: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  if (config.http.enabled) {
    try {
      httpServer = await createHttpServer(orchestrator, {
        port: config.http.port,
        host: config.http.host,
        assistant,
        assistantConfig: config.assistant,
      });
    } catch (error) {
      if (!isRecoverableHttpStartupError(error)) {
        throw error;
      }

      log.error(
        {
          err: error,
          host: config.http.host,
          port: config.http.port,
        },
        "HTTP server failed to bind; continuing without HTTP"
      );
    }
  }

  let discordBot: ReturnType<typeof createDiscordBot> | null = null;
  if (config.discord.enabled) {
    discordBot = createDiscordBot(orchestrator, config, assistant, dailyBrief);
    if (discordBot) {
      await discordBot.start();
    }
  }

  log.info("Codex Orchestrator is running");
  if (config.http.enabled) {
    log.info(`  HTTP: http://${config.http.host}:${config.http.port}/health`);
  }
  log.info(`  Projects: ${config.projects.map(p => p.id).join(", ")}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "Shutting down");
    let hadError = false;

    const runShutdownStep = async (step: string, fn: () => Promise<void> | void) => {
      try {
        await fn();
      } catch (error) {
        hadError = true;
        log.error({ err: error, step }, "Shutdown step failed");
      }
    };

    if (discordBot) {
      await runShutdownStep("discord-bot", () => discordBot!.stop());
    }
    await runShutdownStep("daily-brief", () => dailyBrief.shutdown());
    await runShutdownStep("assistant", () => assistant.shutdown());
    await runShutdownStep("assistant-mirror", () => assistantMirror.shutdown());
    await runShutdownStep("orchestrator", () => orchestrator.shutdown());
    if (httpServer) {
      await runShutdownStep("http-server", () => httpServer!.close());
    }
    await runShutdownStep("database", () => closeDatabase());

    process.exit(hadError ? 1 : 0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
