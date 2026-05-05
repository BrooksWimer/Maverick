import type { OrchestratorConfig } from "../config/index.js";
import { CodexAssistantInterpreter } from "./agent.js";
import { AssistantService } from "./service.js";

export function createAssistantService(
  config: OrchestratorConfig
) {
  const project = config.projects.find((candidate) => candidate.id === config.assistant.agentProjectId);
  const backend = project?.executionBackend ?? config.defaults.executionBackend;
  const interpreter = project ? new CodexAssistantInterpreter(project, backend) : undefined;

  return new AssistantService(config.assistant, {
    interpreter,
  });
}

export { AssistantService } from "./service.js";
