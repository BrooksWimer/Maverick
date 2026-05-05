import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/index.js";

describe("control-plane.shared.json", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Maverick's shipped workflow aligned with agent planning and verification", () => {
    const sharedConfigPath = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../config/control-plane.shared.json",
    );
    const rawShared = JSON.parse(readFileSync(sharedConfigPath, "utf8")) as {
      projects?: Array<{ id: string }>;
    };

    const tempDir = mkdtempSync(join(tmpdir(), "maverick-shared-config-"));
    tempDirs.push(tempDir);

    const projectOverrides = (rawShared.projects ?? []).map((project) => {
      const repoPath = join(tempDir, project.id);
      mkdirSync(repoPath, { recursive: true });
      return {
        id: project.id,
        repoPath,
      };
    });

    const overlayPath = join(tempDir, "control-plane.json");
    writeFileSync(overlayPath, JSON.stringify({
      extends: sharedConfigPath,
      projects: projectOverrides,
    }, null, 2));

    const config = loadConfig(overlayPath);

    expect(config.defaults.workflow.states).toContain("awaiting-decisions");
    expect(config.defaults.workflow.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "planning",
        to: "awaiting-decisions",
        trigger: "operator-input-required",
        autoAdvance: true,
      }),
      expect.objectContaining({
        from: "awaiting-decisions",
        to: "planning",
        trigger: "operator-input-received",
        autoAdvance: true,
      }),
    ]));

    const maverick = config.projects.find((project) => project.id === "maverick");
    expect(maverick).toBeDefined();
    expect(maverick?.claudePlanning?.enabled).toBe(true);
    expect(maverick?.claudePlanning?.routing).toEqual(expect.objectContaining({
      profiles: expect.objectContaining({
        cheap: "haiku",
        default: "sonnet",
        deep: "sonnet",
      }),
      agents: expect.objectContaining({
        planning: "deep",
        epicContext: "default",
      }),
    }));
    expect(maverick?.claudeVerification).toEqual(expect.objectContaining({
      enabled: true,
      autoAfterTurn: true,
      model: "sonnet",
    }));
  });
});
