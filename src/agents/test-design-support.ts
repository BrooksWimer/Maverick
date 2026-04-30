import type { TestDesignCase, TestDesignResult } from "./types.js";

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

function normalizeCase(value: unknown): TestDesignCase | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = asTrimmedString(value.name);
  const purpose = asTrimmedString(value.purpose);
  if (!name || !purpose) {
    return null;
  }

  return {
    name,
    scope:
      value.scope === "unit" || value.scope === "integration" || value.scope === "e2e"
        ? value.scope
        : "integration",
    purpose,
    files: asStringArray(value.files),
  };
}

export function parseTestDesignResult(
  structured: Record<string, unknown> | null,
  fallbackSummary: string,
): TestDesignResult {
  if (!structured || !isRecord(structured)) {
    return {
      strategySummary: fallbackSummary,
      testCases: [],
      verificationChecklist: [],
      suggestedCommands: [],
    };
  }

  return {
    strategySummary: asTrimmedString(structured.strategySummary) || fallbackSummary,
    testCases: Array.isArray(structured.testCases)
      ? structured.testCases
          .map((testCase) => normalizeCase(testCase))
          .filter((testCase): testCase is TestDesignCase => testCase !== null)
      : [],
    verificationChecklist: asStringArray(structured.verificationChecklist),
    suggestedCommands: asStringArray(structured.suggestedCommands),
  };
}

export function renderTestDesignMarkdown(result: TestDesignResult): string {
  return [
    `Strategy: ${result.strategySummary}`,
    result.testCases.length > 0
      ? [
          "Test cases:",
          ...result.testCases.map((testCase) => {
            const files = testCase.files.length > 0 ? ` (${testCase.files.join(", ")})` : "";
            return `- [${testCase.scope}] ${testCase.name}: ${testCase.purpose}${files}`;
          }),
        ].join("\n")
      : null,
    result.verificationChecklist.length > 0
      ? `Verification checklist: ${result.verificationChecklist.join("; ")}`
      : null,
    result.suggestedCommands.length > 0 ? `Suggested commands: ${result.suggestedCommands.join("; ")}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
