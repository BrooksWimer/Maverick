import type { EpicBranchConfig, OrchestratorConfig, ProjectConfig } from "./schema.js";

function epicForLegacyLane(lane: ProjectConfig["defaultLanes"][number]): EpicBranchConfig {
  return {
    id: lane.id,
    branch: lane.baseBranch,
    workstreamPrefix: lane.id,
    description: lane.description,
    charter: {
      summary: lane.description ?? `Durable epic context for ${lane.id}.`,
      bullets: [
        "This epic was migrated from legacy defaultLanes and should be treated as a first-class Discord thread epic.",
        "Workstreams must branch from this epic and finish back into this durable branch.",
      ],
      docs: [
        {
          path: "docs/maverick/PROJECT_CONTEXT.md",
          purpose: "Durable project-level Maverick context.",
        },
        {
          path: `docs/maverick/epics/${lane.id}.md`,
          purpose: "Durable epic/thread context.",
        },
      ],
    },
  };
}

export function normalizeEpicFirstConfig(config: OrchestratorConfig): OrchestratorConfig {
  const projects = config.projects.map((project) => {
    const existingEpicIds = new Set(project.epicBranches.map((epic) => epic.id));
    const migratedLaneEpics = project.defaultLanes
      .filter((lane) => !existingEpicIds.has(lane.id))
      .map((lane) => epicForLegacyLane(lane));
    const epicBranches = [...project.epicBranches, ...migratedLaneEpics];

    return {
      ...project,
      epicBranches,
      defaultLanes: [],
      requireEpicForWorktree: project.workspaceKind === "git" && epicBranches.length > 0
        ? true
        : project.requireEpicForWorktree,
    };
  });

  const projectById = new Map(projects.map((project) => [project.id, project]));
  const discord = {
    ...config.discord,
    routes: config.discord.routes.map((route) => {
      if (!route.lane || route.epicId) {
        return route;
      }

      const project = projectById.get(route.projectId);
      if (!project?.epicBranches.some((epic) => epic.id === route.lane)) {
        return route;
      }

      return {
        ...route,
        epicId: route.lane,
        lane: undefined,
      };
    }),
  };

  return {
    ...config,
    projects,
    discord,
  };
}
