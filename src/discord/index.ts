import { createLogger } from "../logger.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { AssistantService } from "../assistant/index.js";
import { DiscordBot } from "./bot.js";

const log = createLogger("discord");

function isUnsetOrPlaceholder(value: string | undefined): boolean {
  if (!value) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("your-discord-") ||
    normalized === "changeme" ||
    normalized === "placeholder"
  );
}

export function createDiscordBot(
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  assistant?: AssistantService | null
) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (isUnsetOrPlaceholder(token) || isUnsetOrPlaceholder(applicationId)) {
    log.warn(
      "Discord is enabled in config, but DISCORD_BOT_TOKEN or DISCORD_APPLICATION_ID is missing or still set to example placeholder values."
    );
    return null;
  }

  return new DiscordBot(orchestrator, config, {
    token: token!,
    applicationId: applicationId!,
    guildId: guildId || undefined,
  }, assistant ?? null);
}
