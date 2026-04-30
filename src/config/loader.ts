/**
 * Config loader: reads control-plane.json, validates with Zod, merges env overrides.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { OrchestratorConfigSchema, type OrchestratorConfig } from "./schema.js";
import { normalizeEpicFirstConfig } from "./epic-first.js";
import { createLogger } from "../logger.js";
import { isEpicDocPathWithinProject, resolveEpicDocPath } from "../projects/epics.js";

const log = createLogger("config");

const DEFAULT_CONFIG_PATHS = [
  "./config/control-plane.json",
  "./control-plane.json",
];

export function loadConfig(configPath?: string): OrchestratorConfig {
  const resolvedPath = resolveConfigPath(configPath);
  log.info({ path: resolvedPath }, "Loading configuration");

  const parsed = loadConfigWithExtends(resolvedPath, new Set<string>());

  const result = OrchestratorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Config validation failed:\n${issues}`);
  }

  const config = normalizeEpicFirstConfig(result.data);

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

      for (const doc of epic.charter?.docs ?? []) {
        if (!isEpicDocPathWithinProject(project, doc.path)) {
          throw new Error(
            `Project "${project.id}" epic "${epic.id}" doc path "${doc.path}" escapes repoPath "${project.repoPath}"`
          );
        }

        const resolvedDocPath = resolveEpicDocPath(project, doc.path);
        if (!existsSync(resolvedDocPath)) {
          log.warn(
            { projectId: project.id, epicId: epic.id, path: resolvedDocPath },
            "Epic charter doc pointer does not exist yet"
          );
        }
      }
    }

    if (project.requireEpicForWorktree && project.epicBranches.length === 0) {
      throw new Error(`Project "${project.id}" requires epic selection but defines no epicBranches`);
    }

    if (
      project.workspaceKind === "git" &&
      !project.requireEpicForWorktree &&
      !project.defaultWorktreeBaseBranch &&
      project.epicBranches.length === 0
    ) {
      throw new Error(
        `Project "${project.id}" must define defaultWorktreeBaseBranch or at least one epic when workspaceKind is "git".`
      );
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

    if (route.lane && !project.epicBranches.some((epic) => epic.id === route.lane)) {
      throw new Error(
        `Discord route ${route.channelId} references unknown epic/lane "${route.lane}" for project "${route.projectId}"`
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

function loadConfigWithExtends(configPath: string, seenPaths: Set<string>): unknown {
  const resolvedPath = resolve(configPath);
  if (seenPaths.has(resolvedPath)) {
    throw new Error(`Config inheritance cycle detected at ${resolvedPath}`);
  }

  seenPaths.add(resolvedPath);

  try {
    const parsed = parseConfigFile(resolvedPath);
    if (!isJsonObject(parsed)) {
      throw new Error(`Config file ${resolvedPath} must contain a top-level JSON object.`);
    }

    const extendsValue = parsed.extends;
    const currentConfig = { ...parsed };
    delete currentConfig.extends;

    let mergedConfig: unknown = {};
    for (const basePath of resolveInheritedConfigPaths(resolvedPath, extendsValue)) {
      mergedConfig = mergeConfigValues(mergedConfig, loadConfigWithExtends(basePath, seenPaths), []);
    }

    return mergeConfigValues(mergedConfig, currentConfig, []);
  } finally {
    seenPaths.delete(resolvedPath);
  }
}

function parseConfigFile(configPath: string): unknown {
  const raw = readFileSync(configPath, "utf-8");

  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${err}`);
  }
}

function resolveInheritedConfigPaths(configPath: string, extendsValue: unknown): string[] {
  if (extendsValue === undefined) {
    return [];
  }

  const entries = Array.isArray(extendsValue) ? extendsValue : [extendsValue];
  if (!entries.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
    throw new Error(`Config file ${configPath} must declare "extends" as a non-empty string or string array.`);
  }

  const configDir = dirname(configPath);
  return entries.map((entry) => resolve(configDir, entry));
}

function mergeConfigValues(base: unknown, override: unknown, path: string[]): unknown {
  if (override === undefined) {
    return cloneConfigValue(base);
  }

  if (base === undefined) {
    return cloneConfigValue(override);
  }

  if (Array.isArray(base) && Array.isArray(override)) {
    const pathKey = path.join(".");
    if (pathKey === "projects") {
      return mergeNamedObjects(base, override, path, "id");
    }
    if (pathKey === "discord.routes") {
      return mergeDiscordRoutes(base, override, path);
    }

    return cloneConfigValue(override);
  }

  if (isJsonObject(base) && isJsonObject(override)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(base)) {
      result[key] = cloneConfigValue(value);
    }
    for (const [key, value] of Object.entries(override)) {
      result[key] = mergeConfigValues(base[key], value, [...path, key]);
    }
    return result;
  }

  return cloneConfigValue(override);
}

function mergeNamedObjects(
  base: unknown[],
  override: unknown[],
  path: string[],
  identityKey: string
): unknown[] {
  const result = base.map((entry) => cloneConfigValue(entry));
  const indexesById = new Map<string, number>();

  base.forEach((entry, index) => {
    if (isJsonObject(entry) && typeof entry[identityKey] === "string") {
      indexesById.set(entry[identityKey], index);
    }
  });

  for (const entry of override) {
    if (isJsonObject(entry) && typeof entry[identityKey] === "string") {
      const existingIndex = indexesById.get(entry[identityKey]);
      if (existingIndex !== undefined) {
        result[existingIndex] = mergeConfigValues(base[existingIndex], entry, [...path, entry[identityKey]]);
        continue;
      }
    }

    result.push(cloneConfigValue(entry));
  }

  return result;
}

function mergeDiscordRoutes(base: unknown[], override: unknown[], path: string[]): unknown[] {
  const result = base.map((entry) => cloneConfigValue(entry));
  const indexesByKey = new Map<string, number>();

  base.forEach((entry, index) => {
    const key = getDiscordRouteKey(entry);
    if (key) {
      indexesByKey.set(key, index);
    }
  });

  for (const entry of override) {
    const key = getDiscordRouteKey(entry);
    if (key) {
      const existingIndex = indexesByKey.get(key);
      if (existingIndex !== undefined) {
        result[existingIndex] = mergeConfigValues(base[existingIndex], entry, [...path, key]);
        continue;
      }

      indexesByKey.set(key, result.length);
    }

    result.push(cloneConfigValue(entry));
  }

  return result;
}

function getDiscordRouteKey(value: unknown): string | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const projectId = typeof value.projectId === "string" ? value.projectId : null;
  const channelId = typeof value.channelId === "string" ? value.channelId : null;
  const purpose = typeof value.purpose === "string" ? value.purpose : "workstreams";
  const epicId = typeof value.epicId === "string" ? value.epicId : "";

  if (!projectId || !channelId) {
    return null;
  }

  return `${projectId}:${channelId}:${purpose}:${epicId}`;
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfigValue(entry));
  }

  if (isJsonObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneConfigValue(entry);
    }
    return result;
  }

  return value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
