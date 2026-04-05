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
import { createAssistantService } from "./assistant/index.js";

loadEnvironment();

const log = createLogger("main");

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

  const assistant = createAssistantService(config);
  assistant.start();

  // Start HTTP server
  let httpServer: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  if (config.http.enabled) {
    httpServer = await createHttpServer(orchestrator, {
      port: config.http.port,
      host: config.http.host,
      assistant,
      assistantConfig: config.assistant,
    });
  }

  let discordBot: ReturnType<typeof createDiscordBot> | null = null;
  if (config.discord.enabled) {
    discordBot = createDiscordBot(orchestrator, config, assistant);
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
  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down");
    if (discordBot) {
      await discordBot.stop();
    }
    assistant.shutdown();
    await orchestrator.shutdown();
    if (httpServer) await httpServer.close();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});
