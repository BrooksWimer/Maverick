import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanningInstruction } from "../../src/claude/context-builder.js";
import { closeDatabase, initDatabase, projects, workstreams } from "../../src/state/index.js";

describe("buildPlanningInstruction", () => {
  it("includes the core planning context", () => {
    const instruction = buildPlanningInstruction({
      projectId: "maverick",
      workstreamName: "Claude planning",
      instruction: "Implement plan injection",
      agentsMd: "# Rules",
      directoryTree: "- src/\n  - orchestrator.ts",
      recentTurnHistory: [
        {
          instruction: "Phase 2",
          status: "completed",
          summary: "Review flow added",
        },
      ],
      epicCharter: "Keep orchestration explicit",
    });

    expect(instruction).toContain("Implement plan injection");
    expect(instruction).toContain("# Rules");
    expect(instruction).toContain("orchestrator.ts");
    expect(instruction).toContain("Review flow added");
    expect(instruction).toContain("Keep orchestration explicit");
  });
});

describe("workstream plan persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "maverick-plan-"));
    initDatabase(join(tempDir, "plan.db"));
    projects.upsert({
      id: "maverick",
      name: "Maverick",
      repo_path: "C:\\repo\\maverick",
      config_json: "{}",
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("stores plans directly on workstream records", () => {
    const workstream = workstreams.create({
      project_id: "maverick",
      name: "Claude plan storage",
    });

    const updated = workstreams.update(workstream.id, {
      current_goal: "Ship planning",
      plan: "1. Inspect files\n2. Add schema\n3. Test it",
    });

    expect(updated?.plan).toContain("Inspect files");
    expect(updated?.current_goal).toBe("Ship planning");
  });
});
