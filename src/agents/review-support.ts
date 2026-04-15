import type { ReviewResult as ExecutionReviewResult } from "../codex/types.js";
import type { ReviewFinding, ReviewPass } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeSeverity(value: unknown): ExecutionReviewResult["severity"] {
  return value === "clean" || value === "minor" || value === "major" || value === "critical"
    ? value
    : "minor";
}

function normalizeReviewPass(value: unknown): ReviewPass | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = asTrimmedString(value.name);
  if (!name) {
    return null;
  }

  return {
    name,
    status: value.status === "clean" ? "clean" : "findings",
    findingCount: typeof value.findingCount === "number" ? Math.max(0, Math.trunc(value.findingCount)) : 0,
  };
}

function normalizeReviewFinding(value: unknown): ReviewFinding | null {
  if (!isRecord(value)) {
    return null;
  }

  const file = asTrimmedString(value.file);
  const category = asTrimmedString(value.category);
  const description = asTrimmedString(value.description);
  if (!file || !category || !description) {
    return null;
  }

  const severity =
    value.severity === "info" ||
    value.severity === "warning" ||
    value.severity === "error" ||
    value.severity === "critical"
      ? value.severity
      : "warning";

  const line =
    typeof value.line === "number" && Number.isFinite(value.line)
      ? Math.max(1, Math.trunc(value.line))
      : undefined;

  return {
    file,
    line,
    severity,
    category,
    description,
    suggestion: asTrimmedString(value.suggestion) || undefined,
  };
}

function extractNarrative(output: string): string {
  return output.replace(/```(?:json)?\s*[\s\S]+?\s*```/i, "").trim();
}

function formatFindingSection(title: string, findings: ReviewFinding[]): string | null {
  if (findings.length === 0) {
    return null;
  }

  return [
    `${title}:`,
    ...findings.map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- [${finding.severity}] ${location} (${finding.category}) ${finding.description}${finding.suggestion ? ` Suggestion: ${finding.suggestion}` : ""}`;
    }),
  ].join("\n");
}

export function coerceReviewAgentResult(
  structured: Record<string, unknown> | null,
  output: string,
): ExecutionReviewResult {
  if (!structured) {
    return {
      severity: "minor",
      findings: output.trim() || "Claude review returned no content.",
      suggestions: [],
    };
  }

  const passes = Array.isArray(structured.passes)
    ? structured.passes
        .map((pass) => normalizeReviewPass(pass))
        .filter((pass): pass is ReviewPass => pass !== null)
    : [];
  const securityFindings = Array.isArray(structured.securityFindings)
    ? structured.securityFindings
        .map((finding) => normalizeReviewFinding(finding))
        .filter((finding): finding is ReviewFinding => finding !== null)
    : [];
  const architectureFindings = Array.isArray(structured.architectureFindings)
    ? structured.architectureFindings
        .map((finding) => normalizeReviewFinding(finding))
        .filter((finding): finding is ReviewFinding => finding !== null)
    : [];
  const correctnessFindings = Array.isArray(structured.correctnessFindings)
    ? structured.correctnessFindings
        .map((finding) => normalizeReviewFinding(finding))
        .filter((finding): finding is ReviewFinding => finding !== null)
    : [];
  const conventionFindings = Array.isArray(structured.conventionFindings)
    ? structured.conventionFindings
        .map((finding) => normalizeReviewFinding(finding))
        .filter((finding): finding is ReviewFinding => finding !== null)
    : [];
  const suggestions = asStringArray(structured.suggestions);

  const narrative = extractNarrative(output);
  const sections = [
    asTrimmedString(structured.verdict) ? `Verdict: ${asTrimmedString(structured.verdict)}` : null,
    passes.length > 0
      ? [
          "Passes:",
          ...passes.map((pass) => `- ${pass.name}: ${pass.status} (${pass.findingCount} finding${pass.findingCount === 1 ? "" : "s"})`),
        ].join("\n")
      : null,
    formatFindingSection("Security findings", securityFindings),
    formatFindingSection("Architecture findings", architectureFindings),
    formatFindingSection("Correctness findings", correctnessFindings),
    formatFindingSection("Convention findings", conventionFindings),
    suggestions.length > 0 ? ["Suggestions:", ...suggestions.map((suggestion) => `- ${suggestion}`)].join("\n") : null,
    narrative || null,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");

  return {
    severity: normalizeSeverity(structured.severity),
    findings: sections || "No review findings recorded.",
    suggestions,
  };
}
