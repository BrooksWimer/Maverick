import { describe, expect, it } from "vitest";
import {
  buildVerificationContextRecord,
  coerceVerificationResult,
  parseVerificationContextRecord,
  renderVerificationSummary,
} from "../../src/agents/verification-support.js";

describe("verification-support", () => {
  it("normalizes structured verification output", () => {
    const result = coerceVerificationResult(
      {
        status: "pass",
        checks: [
          {
            name: "Tests",
            command: "npm test",
            status: "pass",
            output: "ok",
            duration_ms: 1200,
          },
        ],
        preExistingFailures: [],
        introducedFailures: [],
        recommendation: "ready-for-review",
        fixTargets: [],
      },
      "done",
    );

    expect(result.status).toBe("pass");
    expect(result.checks[0]?.command).toBe("npm test");
    expect(result.recommendation).toBe("ready-for-review");
  });

  it("treats missing structured output as a failed verification", () => {
    const result = coerceVerificationResult(null, "verification crashed");

    expect(result.status).toBe("fail");
    expect(result.introducedFailures).toEqual(["verification crashed"]);
    expect(result.recommendation).toBe("needs-fixes");
  });

  it("round-trips and renders a stored verification context", () => {
    const context = buildVerificationContextRecord({
      result: {
        status: "fail",
        checks: [
          {
            name: "Lint",
            command: "npm run lint",
            status: "fail",
            output: "missing type",
            duration_ms: 250,
          },
        ],
        preExistingFailures: ["legacy flaky test"],
        introducedFailures: ["src/orchestrator/orchestrator.ts fails lint"],
        recommendation: "needs-fixes",
        fixTargets: ["src/orchestrator/orchestrator.ts:120"],
      },
      rawAgentOutput: "raw",
      verificationThreadId: "verify-thread",
      sourceTurnId: "turn-1",
      trigger: "manual",
    });

    const reparsed = parseVerificationContextRecord(JSON.stringify(context));
    expect(reparsed?.verificationThreadId).toBe("verify-thread");
    expect(reparsed?.result.fixTargets).toEqual(["src/orchestrator/orchestrator.ts:120"]);
    expect(renderVerificationSummary(reparsed!)).toContain("## Verification Failed");
    expect(renderVerificationSummary(reparsed!)).toContain("Fix Targets");
  });
});
