import type { OrchestratorConfig } from "../config/index.js";
import { CodexAssistantInterpreter } from "./agent.js";
import { AssistantDriveMirrorService } from "./mirror.js";
import { AssistantService } from "./service.js";
import { createWorkNotesConfig } from "./work-notes.js";

export function createAssistantMirrorService(config: OrchestratorConfig) {
  return new AssistantDriveMirrorService(config);
}

export function createAssistantService(
  config: OrchestratorConfig,
  options?: { mirror?: AssistantDriveMirrorService | null }
) {
  const project = config.projects.find((candidate) => candidate.id === config.assistant.agentProjectId);
  const backend = project?.executionBackend ?? config.defaults.executionBackend;
  const workNotes = createWorkNotesConfig(config);
  const interpreter = project ? new CodexAssistantInterpreter(project, backend, workNotes) : undefined;

  return new AssistantService(config.assistant, {
    interpreter,
    workNotes,
    mirror: options?.mirror ?? null,
  });
}

export { AssistantService } from "./service.js";
