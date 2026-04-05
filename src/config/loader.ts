/**
 * Config loader: reads control-plane.json, validates with Zod, merges env overrides.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "./schema.js";
import { createLogger } from "../logger.js";

const log = createLogger("config");

const DEFAULT_CONFIG_PATHS = [
  "./config/control-plane.json",
  "./control-plane.json",
];

export function loadConfig(configPath?: string): OrchestratorConfig {
  const resolvedPath = resolveConfigPath(configPath);
  log.info({ path: resolvedPath }, "Loading configuration");

  const raw = readFileSync(resolvedPath, "utf-8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${resolvedPath}: ${err}`);
  }

  const result = OrchestratorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const config = result.data;

  const projectById = new Map(config.projects.map((project) => [project.id, project]));

  // Validate project paths exist
  for (const project of config.projects) {
    if (!existsSync(project.repoPath)) {
      log.warn({ projectId: project.id, path: project.repoPath }, "Project repo path does not exist");
    }

    const seenEpicIds = new Set<string>();
    for (const epic of project.epicBranches) {
      if (seenEpicIds.has(epic.id)) {
        throw new Error(`Project "${project.id}" declares duplicate epic id "${epic.id}"`);
      }
      seenEpicIds.add(epic.id);
    }

    if (project.requireEpicForWorktree && project.epicBranches.length === 0) {
      throw new Error(`Project "${project.id}" requires epic selection but defines no epicBranches`);
    }
  }

  // Validate discord route references
  for (const route of config.discord.routes) {
    const project = projectById.get(route.projectId);
    if (!project) {
      throw new Error(`Discord route references unknown project "${route.projectId}"`);
    }

    if (route.epicId && !project.epicBranches.some((epic) => epic.id === route.epicId)) {
      throw new Error(
        `Discord route ${route.channelId} references unknown epic "${route.epicId}" for project "${route.projectId}"`
      );
    }
  }

  // Check for duplicate channel bindings
  const channelBindings = new Map<string, string>();
  for (const route of config.discord.routes) {
    const existing = channelBindings.get(route.channelId);
    if (existing && existing !== route.projectId) {
      throw new Error(
        `Channel ${route.channelId} is bound to both "${existing}" and "${route.projectId}"`
      );
    }
    channelBindings.set(route.channelId, route.projectId);
  }

  log.info({ projects: config.projects.length, routes: config.discord.routes.length }, "Configuration loaded");
  return config;
}

function resolveConfigPath(explicit?: string): string {
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  for (const candidate of DEFAULT_CONFIG_PATHS) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    `No config file found. Searched: ${DEFAULT_CONFIG_PATHS.join(", ")}. ` +
    `Create config/control-plane.json or pass --config <path>.`
  );
}
