import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectConfig } from "../config/schema.js";

type BootstrapScope = "project" | "worktree";

export type BootstrapStatus = {
  projectId: string;
  scope: BootstrapScope;
  rootPath: string;
  agentsMdPath: string;
  skillsPath: string;
  createdFiles: string[];
};

const DEFAULT_AGENTS_RELATIVE_PATH = "AGENTS.md";
const DEFAULT_SKILLS_RELATIVE_PATH = ".agents/skills";

function resolveTemplateRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(process.cwd(), "templates"),
    resolve(dirname(currentFile), "..", "..", "templates"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Could not find Maverick templates directory. Checked: ${candidates.join(", ")}`);
}

function isRelativeTo(basePath: string, targetPath: string): boolean {
  const candidate = relative(basePath, targetPath);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function mapConfiguredPathToRoot(
  repoRoot: string,
  targetRoot: string,
  configuredPath: string | undefined,
  fallbackRelativePath: string
): string {
  if (!configuredPath) {
    return resolve(targetRoot, fallbackRelativePath);
  }

  if (targetRoot === repoRoot) {
    return configuredPath;
  }

  if (isRelativeTo(repoRoot, configuredPath)) {
    const repoRelativePath = relative(repoRoot, configuredPath);
    return resolve(targetRoot, repoRelativePath);
  }

  return resolve(targetRoot, fallbackRelativePath);
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function copyFileIfMissing(sourcePath: string, destinationPath: string, createdFiles: string[]): void {
  if (existsSync(destinationPath)) {
    return;
  }

  ensureParentDirectory(destinationPath);
  copyFileSync(sourcePath, destinationPath);
  createdFiles.push(destinationPath);
}

function copyDirectoryIfMissing(sourceDir: string, destinationDir: string, createdFiles: string[]): void {
  if (!existsSync(destinationDir)) {
    mkdirSync(destinationDir, { recursive: true });
  }

  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = resolve(sourceDir, entry);
    const destinationPath = resolve(destinationDir, entry);
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      copyDirectoryIfMissing(sourcePath, destinationPath, createdFiles);
      continue;
    }

    copyFileIfMissing(sourcePath, destinationPath, createdFiles);
  }
}

function ensureBootstrapAtRoot(
  project: ProjectConfig,
  rootPath: string,
  scope: BootstrapScope
): BootstrapStatus {
  if (!existsSync(rootPath)) {
    throw new Error(`Cannot bootstrap ${scope} for project ${project.id}; path does not exist: ${rootPath}`);
  }

  const templateRoot = resolveTemplateRoot();
  const agentsMdPath = mapConfiguredPathToRoot(
    project.repoPath,
    rootPath,
    project.agentsMdPath,
    DEFAULT_AGENTS_RELATIVE_PATH
  );
  const skillsPath = mapConfiguredPathToRoot(
    project.repoPath,
    rootPath,
    project.skillsPath,
    DEFAULT_SKILLS_RELATIVE_PATH
  );
  const createdFiles: string[] = [];

  copyFileIfMissing(resolve(templateRoot, "AGENTS.md"), agentsMdPath, createdFiles);
  copyDirectoryIfMissing(resolve(templateRoot, ".agents", "skills"), skillsPath, createdFiles);

  return {
    projectId: project.id,
    scope,
    rootPath,
    agentsMdPath,
    skillsPath,
    createdFiles,
  };
}

export function ensureProjectBootstrap(project: ProjectConfig): BootstrapStatus {
  return ensureBootstrapAtRoot(project, project.repoPath, "project");
}

export function ensureWorktreeBootstrap(project: ProjectConfig, worktreePath: string): BootstrapStatus {
  return ensureBootstrapAtRoot(project, worktreePath, "worktree");
}

export function bootstrapSummary(status: BootstrapStatus): string {
  if (status.createdFiles.length === 0) {
    return `Bootstrap already present in ${status.scope} root`;
  }

  const createdNames = status.createdFiles.map((path) => basename(path));
  return `Installed ${createdNames.length} bootstrap file(s) in ${status.scope} root: ${createdNames.join(", ")}`;
}
