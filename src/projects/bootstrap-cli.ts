import { loadEnvironment } from "../config/env.js";
import { loadConfig } from "../config/index.js";
import { ensureProjectBootstrap, bootstrapSummary } from "./bootstrap.js";

loadEnvironment();

const configArgIndex = process.argv.findIndex((arg) => arg === "--config");
const configPath =
  process.argv.find((arg) => arg.startsWith("--config="))?.split("=")[1] ??
  (configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined);

const config = loadConfig(configPath);

for (const project of config.projects) {
  const status = ensureProjectBootstrap(project);
  console.log(
    [
      `Project: ${project.name} (${project.id})`,
      `Repo: ${project.repoPath}`,
      `AGENTS.md: ${status.agentsMdPath}`,
      `Skills: ${status.skillsPath}`,
      `Result: ${bootstrapSummary(status)}`,
      "",
    ].join("\n")
  );
}
