#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mergeProject(base, override) {
  return {
    ...base,
    ...override,
    defaultLanes: override.defaultLanes ?? base.defaultLanes ?? [],
    epicBranches: override.epicBranches ?? base.epicBranches ?? [],
  };
}

function loadConfig(path) {
  const config = readJson(path);
  if (!config.extends) {
    return config;
  }

  const base = loadConfig(resolve(dirname(path), config.extends));
  const overridesById = new Map((config.projects ?? []).map((project) => [project.id, project]));
  const baseIds = new Set((base.projects ?? []).map((project) => project.id));
  const extraProjects = (config.projects ?? []).filter((project) => !baseIds.has(project.id));
  return {
    ...base,
    ...config,
    projects: [
      ...(base.projects ?? []).map((project) =>
        overridesById.has(project.id) ? mergeProject(project, overridesById.get(project.id)) : project
      ),
      ...extraProjects,
    ],
  };
}

function git(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requiredBranches(project) {
  if ((project.workspaceKind ?? "git") !== "git") {
    return [];
  }

  const branches = [];
  if (project.productionBranch) {
    branches.push({ kind: "production", id: "production", branch: project.productionBranch });
  }
  for (const lane of project.defaultLanes ?? []) {
    branches.push({ kind: "lane", id: lane.id, branch: lane.baseBranch });
  }
  for (const epic of project.epicBranches ?? []) {
    branches.push({ kind: "epic", id: epic.id, branch: epic.branch });
  }

  const seen = new Set();
  return branches.filter((entry) => {
    if (seen.has(entry.branch)) {
      return false;
    }
    seen.add(entry.branch);
    return true;
  });
}

const args = process.argv.slice(2);
const createMissing = args.includes("--create-missing");
const exclude = new Set(
  args
    .filter((arg) => arg.startsWith("--exclude="))
    .flatMap((arg) => arg.slice("--exclude=".length).split(","))
    .map((arg) => arg.trim())
    .filter(Boolean)
);

const configPath = resolve(repoRoot, "config", "control-plane.json");
const config = loadConfig(configPath);
let hadMissing = false;

for (const project of config.projects ?? []) {
  if (exclude.has(project.id)) {
    console.log(`SKIP ${project.id}`);
    continue;
  }

  const branches = requiredBranches(project);
  if (branches.length === 0) {
    continue;
  }
  if (!project.repoPath || !existsSync(resolve(project.repoPath, ".git"))) {
    console.log(`MISSING_REPO ${project.id} ${project.repoPath ?? ""}`);
    hadMissing = true;
    continue;
  }

  const remote = git(project.repoPath, ["ls-remote", "--heads", "origin", ...branches.map((entry) => entry.branch)]);
  const refs = new Set(
    remote
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
  );

  for (const entry of branches) {
    const ref = `refs/heads/${entry.branch}`;
    if (refs.has(ref)) {
      console.log(`OK ${project.id} ${entry.kind} ${entry.branch}`);
      continue;
    }

    hadMissing = true;
    console.log(`MISSING ${project.id} ${entry.kind} ${entry.branch}`);
    if (createMissing && entry.kind !== "production" && project.productionBranch) {
      git(project.repoPath, ["push", "origin", `${project.productionBranch}:${ref}`]);
      console.log(`CREATED ${project.id} ${entry.kind} ${entry.branch} from ${project.productionBranch}`);
    }
  }
}

if (hadMissing && !createMissing) {
  process.exitCode = 1;
}
