import type {
  VerificationCheck,
  VerificationContextRecord,
  VerificationResult,
} from "./types.js";
import { parseIncidentTriageResult } from "./incident-triage-support.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerificationContextRecord(value: unknown): value is VerificationContextRecord {
  return isRecord(value) && "verificationThreadId" in value && "result" in value;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry) => entry.length > 0);
}

function normalizeCheck(value: unknown): VerificationCheck | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = asTrimmedString(value.name);
  const command = asTrimmedString(value.command);
  if (!name || !command) {
    return null;
  }

  return {
    name,
    command,
    status:
      value.status === "pass" ||
      value.status === "fail" ||
      value.status === "skipped" ||
      value.status === "error"
        ? value.status
        : "error",
    output: asTrimmedString(value.output),
    duration_ms:
      typeof value.duration_ms === "number" && Number.isFinite(value.duration_ms)
        ? Math.max(0, Math.trunc(value.duration_ms))
        : 0,
  };
}

export function coerceVerificationResult(
  structured: Record<string, unknown> | null,
  output: string,
): VerificationResult {
  if (!structured) {
    const fallback = output.trim() || "Verification agent returned no structured output.";
    return {
      status: "fail",
      checks: [],
      preExistingFailures: [],
      introducedFailures: [fallback],
      recommendation: "needs-fixes",
      fixTargets: [],
    };
  }

  return {
    status: structured.status === "pass" ? "pass" : "fail",
    checks: Array.isArray(structured.checks)
      ? structured.checks
          .map((check) => normalizeCheck(check))
          .filter((check): check is VerificationCheck => check !== null)
      : [],
    preExistingFailures: asStringArray(structured.preExistingFailures),
    introducedFailures: asStringArray(structured.introducedFailures),
    recommendation: structured.recommendation === "ready-for-review" ? "ready-for-review" : "needs-fixes",
    fixTargets: asStringArray(structured.fixTargets),
  };
}

export function buildVerificationContextRecord(params: {
  result: VerificationResult;
  rawAgentOutput: string;
  verificationThreadId: string | null;
  sourceTurnId: string | null;
  trigger: "manual" | "auto";
  previous?: VerificationContextRecord | null;
}): VerificationContextRecord {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    verificationThreadId: params.verificationThreadId,
    sourceTurnId: params.sourceTurnId,
    trigger: params.trigger,
    result: params.result,
    incidentTriage: params.previous?.incidentTriage ?? null,
    rawAgentOutput: params.rawAgentOutput,
    createdAt: params.previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export function parseVerificationContextRecord(
  value: string | null | undefined,
): VerificationContextRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(parsed) || !isRecord(parsed.result)) {
      return null;
    }

    return {
      schemaVersion:
        typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
          ? Math.max(1, Math.trunc(parsed.schemaVersion))
          : 1,
      verificationThreadId: asTrimmedString(parsed.verificationThreadId) || null,
      sourceTurnId: asTrimmedString(parsed.sourceTurnId) || null,
      trigger: parsed.trigger === "auto" ? "auto" : "manual",
      result: coerceVerificationResult(parsed.result, asTrimmedString(parsed.rawAgentOutput)),
      incidentTriage: parseIncidentTriageResult(parsed.incidentTriage),
      rawAgentOutput: asTrimmedString(parsed.rawAgentOutput),
      createdAt: asTrimmedString(parsed.createdAt) || new Date(0).toISOString(),
      updatedAt: asTrimmedString(parsed.updatedAt) || asTrimmedString(parsed.createdAt) || new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function summarizeCheck(check: VerificationCheck): string {
  const durationSuffix = check.duration_ms > 0 ? ` (${check.duration_ms} ms)` : "";
  return `- ${check.name}: ${check.status} via \`${check.command}\`${durationSuffix}`;
}

export function renderVerificationSummary(
  input: VerificationContextRecord | VerificationResult,
): string {
  let context: VerificationContextRecord | null = null;
  let result: VerificationResult;
  if (isVerificationContextRecord(input)) {
    context = input;
    result = input.result;
  } else {
    result = input;
  }
  const fixTargets = result.fixTargets ?? [];

  return [
    `## Verification ${result.status === "pass" ? "Passed" : "Failed"}`,
    `Recommendation: ${result.recommendation}`,
    result.checks.length > 0
      ? ["", "### Checks", ...result.checks.map((check) => summarizeCheck(check))].join("\n")
      : null,
    result.introducedFailures.length > 0
      ? ["", "### Introduced Failures", ...result.introducedFailures.map((failure) => `- ${failure}`)].join("\n")
      : null,
    result.preExistingFailures.length > 0
      ? ["", "### Pre-Existing Failures", ...result.preExistingFailures.map((failure) => `- ${failure}`)].join("\n")
      : null,
    fixTargets.length > 0
      ? ["", "### Fix Targets", ...fixTargets.map((target) => `- ${target}`)].join("\n")
      : null,
    context?.incidentTriage
      ? [
          "",
          "### Incident Triage",
          `Severity: ${context.incidentTriage.severity}`,
          `Root cause: ${context.incidentTriage.rootCause}`,
          `Suggested fix: ${context.incidentTriage.suggestedFix}`,
          context.incidentTriage.escalationNeeded && context.incidentTriage.escalationReason
            ? `Escalation: ${context.incidentTriage.escalationReason}`
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n")
      : null,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n");
}
