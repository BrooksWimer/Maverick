import type { OrchestratorConfig } from "../config/index.js";
import { CodexAssistantInterpreter } from "./agent.js";
import { AssistantService } from "./service.js";
import { createWorkNotesConfig } from "./work-notes.js";

export function createAssistantService(config: OrchestratorConfig) {
  const project = config.projects.find((candidate) => candidate.id === config.assistant.agentProjectId);
  const backend = project?.executionBackend ?? config.defaults.executionBackend;
  const workNotes = createWorkNotesConfig(config);
  const interpreter = project ? new CodexAssistantInterpreter(project, backend, workNotes) : undefined;

  return new AssistantService(config.assistant, {
    interpreter,
    workNotes,
  });
}

export { AssistantService } from "./service.js";
