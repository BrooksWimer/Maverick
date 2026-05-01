import type {
  IntakeResult,
  PendingPlanningDecision,
  PlanStep,
  PlanningAnswer,
  PlanningChangedFileSummary,
  PlanningContextBundle,
  PlanningContextRecord,
  PlanningDecision,
  PlanningResult,
} from "./types.js";
import { parseIntakeResult, renderIntakeMarkdown } from "./intake-agent.js";

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

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return fallback;
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function summarizeRawOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "Planning output was empty.";
  }

  if (trimmed.length <= 400) {
    return trimmed;
  }

  return `${trimmed.slice(0, 397)}...`;
}

function tryParseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredObjectFromRawOutput(rawOutput: string): Record<string, unknown> | null {
  const fencedJsonBlocks = rawOutput.matchAll(/```(?:json|JSON)\s*([\s\S]*?)```/g);
  for (const match of fencedJsonBlocks) {
    const parsed = tryParseJsonObject(match[1]?.trim() ?? "");
    if (parsed) {
      return parsed;
    }
  }

  const summaryKeyIndex = rawOutput.indexOf('"currentStateSummary"');
  if (summaryKeyIndex < 0) {
    return null;
  }

  const startIndex = rawOutput.lastIndexOf("{", summaryKeyIndex);
  if (startIndex < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < rawOutput.length; index += 1) {
    const char = rawOutput[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return tryParseJsonObject(rawOutput.slice(startIndex, index + 1));
      }
    }
  }

  return null;
}

function isFallbackPlanningResult(result: PlanningResult): boolean {
  return (
    result.currentStateSummary === "Planning returned unstructured output. Review the stored raw plan text before dispatch."
    && result.requiredAnswers.length === 0
    && result.importantDecisions.length === 0
    && result.steps.length === 0
    && result.risks.length === 0
    && result.dependencies.length === 0
    && result.testStrategy.length === 0
    && result.rollbackPlan.length === 0
  );
}

function synthesizePendingQuestionsFromIntake(intake: IntakeResult | null): PendingPlanningDecision[] {
  const clarificationQuestions = intake?.clarificationQuestions ?? [];
  if (clarificationQuestions.length === 0) {
    return [];
  }

  return clarificationQuestions.map((question, index) => ({
    id: `clarification-${index + 1}`,
    question,
    whyItMatters: "The intake phase marked this as unresolved before Maverick can dispatch safely.",
    options: [],
    kind: "required-answer",
  }));
}

function buildPendingQuestions(params: {
  result: PlanningResult;
  intake?: IntakeResult | null;
}): PendingPlanningDecision[] {
  const structuredQuestions = collectPendingPlanningQuestions(params.result);
  if (structuredQuestions.length > 0) {
    return structuredQuestions;
  }

  if (!isFallbackPlanningResult(params.result)) {
    return [];
  }

  return synthesizePendingQuestionsFromIntake(params.intake ?? null);
}

function normalizePlanStep(value: unknown, index: number): PlanStep | null {
  if (!isRecord(value)) {
    return null;
  }

  const description = asTrimmedString(value.description);
  if (!description) {
    return null;
  }

  return {
    order: asPositiveInteger(value.order, index + 1),
    description,
    files: asStringArray(value.files),
    verification: asTrimmedString(value.verification),
    canParallelize: Boolean(value.canParallelize),
  };
}

function normalizeDecision(value: unknown, prefix: string, index: number): PlanningDecision | null {
  if (!isRecord(value)) {
    return null;
  }

  const question = asTrimmedString(value.question);
  const whyItMatters = asTrimmedString(value.whyItMatters);

  if (!question || !whyItMatters) {
    return null;
  }

  return {
    id: slugify(asTrimmedString(value.id) || question, `${prefix}-${index + 1}`),
    question,
    whyItMatters,
    options: asStringArray(value.options),
  };
}

function normalizeResultFromStructured(
  structured: Record<string, unknown>,
  rawOutput: string,
): PlanningResult {
  const steps = Array.isArray(structured.steps)
    ? structured.steps
        .map((step, index) => normalizePlanStep(step, index))
        .filter((step): step is PlanStep => step !== null)
        .sort((left, right) => left.order - right.order)
    : [];

  const currentStateSummary = asTrimmedString(structured.currentStateSummary) || summarizeRawOutput(rawOutput);
  const recommendedNextSlice =
    asTrimmedString(structured.recommendedNextSlice) ||
    "Review the planning summary and decide whether additional operator input is required.";
  const requiredAnswers = Array.isArray(structured.requiredAnswers)
    ? structured.requiredAnswers
        .map((entry, index) => normalizeDecision(entry, "required-answer", index))
        .filter((entry): entry is PlanningDecision => entry !== null)
    : [];
  const importantDecisions = Array.isArray(structured.importantDecisions)
    ? structured.importantDecisions
        .map((entry, index) => normalizeDecision(entry, "important-decision", index))
        .filter((entry): entry is PlanningDecision => entry !== null)
    : [];

  return {
    currentStateSummary,
    recommendedNextSlice,
    requiredAnswers,
    importantDecisions,
    draftExecutionPrompt: asTrimmedString(structured.draftExecutionPrompt),
    finalExecutionPrompt: asTrimmedString(structured.finalExecutionPrompt),
    remainingUnknowns: asStringArray(structured.remainingUnknowns),
    steps,
    risks: asStringArray(structured.risks),
    dependencies: asStringArray(structured.dependencies),
    estimatedTurns: asPositiveInteger(structured.estimatedTurns, steps.length || 1),
    testStrategy: asTrimmedString(structured.testStrategy),
    rollbackPlan: asTrimmedString(structured.rollbackPlan),
  };
}

function fallbackPlanningResult(rawOutput: string): PlanningResult {
  return {
    currentStateSummary: "Planning returned unstructured output. Review the stored raw plan text before dispatch.",
    recommendedNextSlice: "Review the raw planning output and answer any pending planning questions before dispatch.",
    requiredAnswers: [],
    importantDecisions: [],
    draftExecutionPrompt: "",
    finalExecutionPrompt: "",
    remainingUnknowns: [],
    steps: [],
    risks: [],
    dependencies: [],
    estimatedTurns: 1,
    testStrategy: "",
    rollbackPlan: "",
  };
}

function stripMarkdownNoise(value: string): string {
  return value
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSection(content: string, heading: string): string {
  const lines = content.split(/\r?\n/);
  const headingPattern = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (startIndex < 0) {
    return "";
  }

  const startHeading = lines[startIndex]?.match(/^(#+)/)?.[1].length ?? 1;
  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const headingMatch = line.match(/^(#+)\s+/);
    if (headingMatch && headingMatch[1].length <= startHeading) {
      break;
    }
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function extractFirstFenceAfter(content: string, marker: string): string {
  const markerIndex = content.toLowerCase().indexOf(marker.toLowerCase());
  if (markerIndex < 0) {
    return "";
  }

  const afterMarker = content.slice(markerIndex + marker.length);
  const match = afterMarker.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
  return match?.[1]?.trim() ?? "";
}

function extractReadyDispatchPrompt(content: string): string {
  return (
    extractFirstFenceAfter(content, "Ready Dispatch Prompt") ||
    extractFirstFenceAfter(content, "finalExecutionPrompt") ||
    extractFirstFenceAfter(content, "Final Codex execution prompt")
  );
}

function extractBulletItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1] ?? "")
    .map(stripMarkdownNoise)
    .filter(Boolean);
}

function extractMainFiles(content: string): string[] {
  const mainFiles = extractSection(content, "Main Files");
  const matches = [...mainFiles.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return [...new Set(matches)];
}

function extractStepsFromPrompt(finalExecutionPrompt: string, fallbackFiles: string[]): PlanStep[] {
  const numberedSteps = finalExecutionPrompt
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\.\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      order: Number.parseInt(match[1], 10),
      description: stripMarkdownNoise(match[2] ?? ""),
      files: fallbackFiles,
      verification: "Use the verification checklist from the durable planning record.",
      canParallelize: false,
    }))
    .filter((step) => step.description);

  if (numberedSteps.length > 0) {
    return numberedSteps;
  }

  return [{
    order: 1,
    description: "Implement the recovered planning prompt.",
    files: fallbackFiles,
    verification: "Use the verification checklist from the durable planning record.",
    canParallelize: false,
  }];
}

function summarizeStructuredPlan(rawOutput: string, finalExecutionPrompt: string): string {
  const firstParagraph = rawOutput
    .split(/\r?\n\r?\n/)
    .map(stripMarkdownNoise)
    .find(Boolean);
  if (firstParagraph) {
    return firstParagraph;
  }

  return `Recovered a dispatch-ready execution prompt: ${stripMarkdownNoise(finalExecutionPrompt).slice(0, 220)}`;
}

export function structureRawPlanningOutput(params: {
  originalInstruction: string;
  rawAgentOutput: string;
  contextBundle?: PlanningContextBundle | null;
  supplementalDocs?: string[];
}): PlanningResult | null {
  const rawAgentOutput = params.rawAgentOutput.trim();
  const parsed = parsePlanningResult(null, rawAgentOutput);
  if (parsed.finalExecutionPrompt.trim() || parsed.requiredAnswers.length > 0 || parsed.importantDecisions.length > 0) {
    return parsed;
  }

  const supplementalDocs = params.supplementalDocs ?? [];
  const combinedContext = [
    params.contextBundle?.projectContext,
    params.contextBundle?.epicContext,
    ...supplementalDocs,
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n\n");

  const finalExecutionPrompt =
    extractReadyDispatchPrompt(combinedContext) ||
    extractReadyDispatchPrompt(rawAgentOutput);

  if (!finalExecutionPrompt.trim()) {
    return null;
  }

  const mainFiles = extractMainFiles(combinedContext);
  const verificationChecklist = extractBulletItems(extractSection(combinedContext, "Verification Checklist"));
  const constraints = extractBulletItems(extractSection(combinedContext, "Constraints"));
  const todoItems = extractBulletItems(extractSection(combinedContext, "TODO"));

  return {
    currentStateSummary: summarizeStructuredPlan(rawAgentOutput, finalExecutionPrompt),
    recommendedNextSlice: "Dispatch the recovered execution prompt from the durable planning record.",
    requiredAnswers: [],
    importantDecisions: [],
    draftExecutionPrompt: finalExecutionPrompt,
    finalExecutionPrompt,
    remainingUnknowns: todoItems,
    steps: extractStepsFromPrompt(finalExecutionPrompt, mainFiles),
    risks: constraints.slice(0, 8),
    dependencies: [],
    estimatedTurns: Math.max(1, extractStepsFromPrompt(finalExecutionPrompt, mainFiles).length),
    testStrategy: verificationChecklist.length > 0
      ? verificationChecklist.join("; ")
      : "Run the narrowest verification that proves the recovered implementation prompt.",
    rollbackPlan: "Revert the disposable workstream changes or reset the worktree back to the durable epic branch before finish.",
  };
}

function normalizeAnswer(value: unknown, questionId: string): PlanningAnswer | null {
  if (!isRecord(value)) {
    return null;
  }

  const answer = asTrimmedString(value.answer);
  if (!answer) {
    return null;
  }

  const answeredAt = asTrimmedString(value.answeredAt);
  return {
    questionId,
    answer,
    answeredAt: answeredAt || new Date().toISOString(),
    answeredBy: asTrimmedString(value.answeredBy) || null,
  };
}

function normalizeIntake(value: unknown, instruction: string): IntakeResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return parseIntakeResult(value, instruction);
}

function normalizeChangedFileSummary(value: unknown): PlanningChangedFileSummary | null {
  if (!isRecord(value)) {
    return null;
  }

  const path = asTrimmedString(value.path);
  if (!path) {
    return null;
  }

  return {
    path,
    status: asTrimmedString(value.status) || "changed",
    summary: asTrimmedString(value.summary) || "Changed since the last saved planning context.",
  };
}

function normalizePlanningContextBundle(value: unknown): PlanningContextBundle | null {
  if (!isRecord(value)) {
    return null;
  }

  const contextFingerprint = asTrimmedString(value.contextFingerprint);
  if (!contextFingerprint) {
    return null;
  }

  return {
    schemaVersion: asPositiveInteger(value.schemaVersion, 1),
    projectContextPath: asTrimmedString(value.projectContextPath) || null,
    projectContext: asTrimmedString(value.projectContext),
    projectMemoryPath: asTrimmedString(value.projectMemoryPath) || null,
    projectMemory: asTrimmedString(value.projectMemory),
    epicContextPath: asTrimmedString(value.epicContextPath) || null,
    epicContext: asTrimmedString(value.epicContext),
    agentsPath: asTrimmedString(value.agentsPath) || null,
    agentsSummary: asTrimmedString(value.agentsSummary),
    contextFingerprint,
    previousContextFingerprint: asTrimmedString(value.previousContextFingerprint) || null,
    fingerprintChanged: Boolean(value.fingerprintChanged),
    fingerprintInputs: isRecord(value.fingerprintInputs)
      ? Object.fromEntries(
          Object.entries(value.fingerprintInputs)
            .map(([key, inputValue]) => [key, asTrimmedString(inputValue)] as const)
            .filter((entry) => entry[1].length > 0)
        )
      : {},
    changedEvidence: asStringArray(value.changedEvidence),
    changedFiles: Array.isArray(value.changedFiles)
      ? value.changedFiles
          .map((entry) => normalizeChangedFileSummary(entry))
          .filter((entry): entry is PlanningChangedFileSummary => entry !== null)
      : [],
    broaderInspectionPolicy:
      asTrimmedString(value.broaderInspectionPolicy) ||
      "Use only the provided context bundle. Request broader inspection only with exact paths or patterns and a concrete reason.",
    boundedAddDirs: asStringArray(value.boundedAddDirs),
  };
}

export function parsePlanningResult(
  structured: Record<string, unknown> | null,
  rawOutput: string,
): PlanningResult {
  const structuredOutput = structured ?? extractStructuredObjectFromRawOutput(rawOutput);
  if (!structuredOutput) {
    return fallbackPlanningResult(rawOutput);
  }

  return normalizeResultFromStructured(structuredOutput, rawOutput);
}

export function collectPendingPlanningQuestions(result: PlanningResult): PendingPlanningDecision[] {
  return [
    ...result.requiredAnswers.map<PendingPlanningDecision>((question) => ({
      ...question,
      kind: "required-answer",
    })),
    ...result.importantDecisions.map<PendingPlanningDecision>((question) => ({
      ...question,
      kind: "important-decision",
    })),
  ];
}

export function parsePlanningContextRecord(value: string | null): PlanningContextRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const originalInstruction = asTrimmedString(parsed.originalInstruction);
    const rawAgentOutput = asTrimmedString(parsed.rawAgentOutput);
    const resultValue = isRecord(parsed.result) ? parsed.result : {};
    let result = normalizeResultFromStructured(resultValue, rawAgentOutput);
    if (isFallbackPlanningResult(result)) {
      result = parsePlanningResult(null, rawAgentOutput);
    }
    const intake = normalizeIntake(parsed.intake, originalInstruction);
    const contextBundle = normalizePlanningContextBundle(parsed.contextBundle);
    const answersSource = isRecord(parsed.answers) ? parsed.answers : {};
    const answers = Object.fromEntries(
      Object.entries(answersSource)
        .map(([questionId, answerValue]) => [questionId, normalizeAnswer(answerValue, questionId)] as const)
        .filter((entry): entry is readonly [string, PlanningAnswer] => entry[1] !== null)
    );
    const parsedPendingQuestions = Array.isArray(parsed.pendingQuestions) && parsed.pendingQuestions.length > 0
      ? parsed.pendingQuestions
          .map((entry, index) => {
            const normalized = normalizeDecision(entry, "pending-question", index);
            if (!normalized || !isRecord(entry)) {
              return null;
            }

            const kind = entry.kind === "important-decision" ? "important-decision" : "required-answer";
            return { ...normalized, kind } satisfies PendingPlanningDecision;
          })
          .filter((entry): entry is PendingPlanningDecision => entry !== null)
      : [];
    const synthesizedPendingQuestions = buildPendingQuestions({ result, intake });
    const pendingQuestions = (isFallbackPlanningResult(result) && synthesizedPendingQuestions.length > parsedPendingQuestions.length
        ? synthesizedPendingQuestions
        : parsedPendingQuestions.length > 0
          ? parsedPendingQuestions
          : synthesizedPendingQuestions
    ).filter((question) => {
      const existingAnswer = answers[question.id];
      return !existingAnswer || !existingAnswer.answer.trim();
    });

    const createdAt = asTrimmedString(parsed.createdAt) || new Date().toISOString();
    const updatedAt = asTrimmedString(parsed.updatedAt) || createdAt;
    const finalExecutionPrompt = asTrimmedString(parsed.finalExecutionPrompt) || null;
    const status =
      pendingQuestions.length > 0
        ? "needs-answers"
        : finalExecutionPrompt
          ? "ready"
          : parsed.status === "ready"
            ? "needs-final-prompt"
            : parsed.status === "needs-final-prompt"
              ? "needs-final-prompt"
              : "needs-final-prompt";

    return {
      schemaVersion: asPositiveInteger(parsed.schemaVersion, 4),
      originalInstruction,
      planningThreadId: asTrimmedString(parsed.planningThreadId) || null,
      contextBundle,
      intake,
      result,
      pendingQuestions,
      answers,
      finalExecutionPrompt,
      status,
      rawAgentOutput,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function buildPlanningContextRecord(params: {
  originalInstruction: string;
  result: PlanningResult;
  rawAgentOutput: string;
  intake?: IntakeResult | null;
  contextBundle?: PlanningContextBundle | null;
  answers?: Record<string, PlanningAnswer>;
  planningThreadId?: string | null;
  previous?: PlanningContextRecord | null;
  now?: string;
}): PlanningContextRecord {
  const now = params.now ?? new Date().toISOString();
  const answers = params.answers ?? params.previous?.answers ?? {};
  const pendingQuestions = buildPendingQuestions({
    result: params.result,
    intake: params.intake ?? params.previous?.intake ?? null,
  }).filter((question) => {
    const existingAnswer = answers[question.id];
    return !existingAnswer || !existingAnswer.answer.trim();
  });
  const finalExecutionPrompt = params.result.finalExecutionPrompt.trim() || null;
  const status =
    pendingQuestions.length > 0
      ? "needs-answers"
      : finalExecutionPrompt
        ? "ready"
        : "needs-final-prompt";

  return {
    schemaVersion: 5,
    originalInstruction: params.originalInstruction,
    planningThreadId: params.planningThreadId ?? params.previous?.planningThreadId ?? null,
    contextBundle: params.contextBundle ?? params.previous?.contextBundle ?? null,
    intake: params.intake ?? params.previous?.intake ?? null,
    result: params.result,
    pendingQuestions,
    answers,
    finalExecutionPrompt,
    status,
    rawAgentOutput: params.rawAgentOutput.trim(),
    createdAt: params.previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export function mergePlanningAnswers(
  context: PlanningContextRecord,
  answers: Record<string, string>,
  options?: {
    answeredBy?: string | null;
    answeredAt?: string;
  },
): {
  mergedAnswers: Record<string, PlanningAnswer>;
  appliedIds: string[];
  unknownIds: string[];
} {
  const knownIds = new Set(context.pendingQuestions.map((question) => question.id));
  const mergedAnswers = { ...context.answers };
  const appliedIds: string[] = [];
  const unknownIds: string[] = [];
  const answeredAt = options?.answeredAt ?? new Date().toISOString();

  for (const [questionId, answer] of Object.entries(answers)) {
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer) {
      continue;
    }

    if (!knownIds.has(questionId)) {
      unknownIds.push(questionId);
      continue;
    }

    mergedAnswers[questionId] = {
      questionId,
      answer: normalizedAnswer,
      answeredAt,
      answeredBy: options?.answeredBy ?? null,
    };
    appliedIds.push(questionId);
  }

  return { mergedAnswers, appliedIds, unknownIds };
}

export function renderPlanningSummary(
  context: PlanningContextRecord,
  options?: {
    includeAgentSections?: boolean;
    includeRawOutput?: boolean;
  },
): string {
  const includeRawOutput = options?.includeRawOutput ?? true;
  const intakeSummary = context.intake ? renderIntakeMarkdown(context.intake) : "None recorded.";
  const contextBundleSummary = context.contextBundle
    ? [
        `Fingerprint: ${context.contextBundle.contextFingerprint}`,
        `Changed: ${context.contextBundle.fingerprintChanged ? "yes" : "no"}`,
        context.contextBundle.changedEvidence.length > 0
          ? `Changed evidence: ${context.contextBundle.changedEvidence.join("; ")}`
          : "Changed evidence: none",
        context.contextBundle.projectMemoryPath
          ? `Project memory: ${context.contextBundle.projectMemoryPath}`
          : "Project memory: none",
      ].join("\n")
    : "None recorded.";
  const pendingQuestions = context.pendingQuestions.length > 0
    ? context.pendingQuestions
        .map((question, index) => {
          const answer = context.answers[question.id];
          return [
            `${index + 1}. [${question.kind}] ${question.id}: ${question.question}`,
            `   Why it matters: ${question.whyItMatters}`,
            answer ? `   Answer: ${answer.answer}` : null,
            question.options && question.options.length > 0
              ? `   Options: ${question.options.join(", ")}`
              : null,
          ]
            .filter((line): line is string => line !== null)
            .join("\n");
        })
        .join("\n")
    : "None.";

  const steps = context.result.steps.length > 0
    ? context.result.steps
        .map((step) => {
          const files = step.files.length > 0 ? ` (${step.files.join(", ")})` : "";
          const verification = step.verification ? ` Verify: ${step.verification}` : "";
          return `${step.order}. ${step.description}${files}${verification}`;
        })
        .join("\n")
    : "None captured.";
  const rawPlanningOutputSection = includeRawOutput && context.rawAgentOutput
    ? ["", "Raw planning output:", context.rawAgentOutput]
    : [];
  const isFallback = isFallbackPlanningResult(context.result);

  return [
    "Structured intake:",
    intakeSummary,
    "",
    "Bounded planning context:",
    contextBundleSummary,
    "",
    "Current state summary:",
    context.result.currentStateSummary || "None recorded.",
    "",
    "Recommended next slice:",
    context.result.recommendedNextSlice || "None recorded.",
    "",
    "Pending planning questions:",
    pendingQuestions,
    ...rawPlanningOutputSection,
    ...(isFallback
      ? []
      : [
          "",
          "Implementation steps:",
          steps,
          "",
          "Risks:",
          context.result.risks.length > 0 ? context.result.risks.map((risk) => `- ${risk}`).join("\n") : "None recorded.",
          "",
          "Dependencies:",
          context.result.dependencies.length > 0
            ? context.result.dependencies.map((dependency) => `- ${dependency}`).join("\n")
            : "None recorded.",
          "",
          "Test strategy:",
          context.result.testStrategy || "None recorded.",
          "",
          "Rollback plan:",
          context.result.rollbackPlan || "None recorded.",
        ]),
    "",
    context.finalExecutionPrompt
      ? "Final Codex execution prompt:\n" + context.finalExecutionPrompt
      : "Draft Codex execution prompt:\n" + (context.result.draftExecutionPrompt || "Not ready yet."),
  ].join("\n");
}

export function serializePlanningAnswers(answers: Record<string, PlanningAnswer>): string {
  const entries = Object.values(answers).sort((left, right) => left.questionId.localeCompare(right.questionId));
  if (entries.length === 0) {
    return "No operator answers recorded yet.";
  }

  return entries
    .map((entry) => {
      const answeredBy = entry.answeredBy ? ` by ${entry.answeredBy}` : "";
      return `- ${entry.questionId}: ${entry.answer} (${entry.answeredAt}${answeredBy})`;
    })
    .join("\n");
}
