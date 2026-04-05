import { describe, expect, it } from "vitest";
import { deriveWorktreeNames } from "../../src/git/worktree.js";

describe("deriveWorktreeNames", () => {
  it("includes the epic lane in generated branch names and worktree paths", () => {
    const names = deriveWorktreeNames({
      projectId: "netwise",
      workstreamId: "dc7c0af4-5500-4311-9b25-ef8c408f2f86",
      name: "netwise laptop scanner v2",
      lane: "laptop-wifi-scanner",
    });

    expect(names.branch).toBe(
      "maverick/netwise/laptop-wifi-scanner/netwise-laptop-scanner-v2-dc7c0af4"
    );
    expect(names.relativeSegments).toEqual([
      "netwise",
      "laptop-wifi-scanner",
      "netwise-laptop-scanner-v2-dc7c0af4",
    ]);
  });

  it("preserves the legacy branch shape when no lane is provided", () => {
    const names = deriveWorktreeNames({
      projectId: "maverick",
      workstreamId: "12345678-1234-1234-1234-123456789abc",
      name: "control plane cleanup",
    });

    expect(names.branch).toBe("maverick/maverick/control-plane-cleanup-12345678");
    expect(names.relativeSegments).toEqual([
      "maverick",
      "control-plane-cleanup-12345678",
    ]);
  });
});
