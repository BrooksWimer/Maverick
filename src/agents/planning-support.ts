import type {
  ExplanationResult,
  GoalFrameResult,
  IntakeResult,
  ModelingResult,
  OperatorFeedbackQuestion,
  OperatorFeedbackResult,
  PendingPlanningDecision,
  PlanStep,
  PlanningAnswer,
  PlanningContextRecord,
  PlanningDecision,
  PlanningResult,
  TestDesignCase,
  TestDesignResult,
} from "./types.js";
import { parseGoalFrameResult, parseIntakeResult, renderGoalFrameMarkdown, renderIntakeMarkdown } from "./goal-framing-support.js";
import { renderModelingMarkdown } from "./modeling-support.js";
import { coerceOperatorFeedbackResult, renderOperatorFeedbackMarkdown } from "./operator-feedback-support.js";
import { renderTestDesignMarkdown } from "./test-design-support.js";

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

function synthesizePendingQuestionsFromFeedback(
  feedbackRequest: OperatorFeedbackResult | null,
): PendingPlanningDecision[] {
  if (!feedbackRequest) {
    return [];
  }

  return feedbackRequest.questions.map((question) => ({
    id: question.questionId,
    question: question.prompt,
    whyItMatters: question.whyItMatters || "Maverick needs this answer before dispatch is safe.",
    options: question.options,
    kind: question.label.toLowerCase().includes("decision") ? "important-decision" : "required-answer",
  }));
}

function feedbackMatchesPendingQuestions(
  feedbackRequest: OperatorFeedbackResult | null,
  pendingQuestions: PendingPlanningDecision[],
): boolean {
  if (pendingQuestions.length === 0) {
    return true;
  }

  const feedbackQuestionIds = new Set(feedbackRequest?.questions.map((question) => question.questionId) ?? []);
  return (
    pendingQuestions.every((question) => feedbackQuestionIds.has(question.id)) &&
    feedbackQuestionIds.size === pendingQuestions.length
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

function synthesizePendingQuestionsFromModeling(modeling: ModelingResult | null): PendingPlanningDecision[] {
  const openQuestions = modeling?.openQuestions ?? [];
  if (openQuestions.length === 0) {
    return [];
  }

  return openQuestions.map((question, index) => ({
    id: `open-question-${index + 1}`,
    question,
    whyItMatters: "The system model marked this as unresolved before Maverick can dispatch safely.",
    options: [],
    kind: "required-answer",
  }));
}

function buildPendingQuestions(params: {
  result: PlanningResult;
  intake?: IntakeResult | null;
  modeling?: ModelingResult | null;
  feedbackRequest?: OperatorFeedbackResult | null;
}): PendingPlanningDecision[] {
  const structuredQuestions = collectPendingPlanningQuestions(params.result);
  if (structuredQuestions.length > 0) {
    return structuredQuestions;
  }

  if (!isFallbackPlanningResult(params.result)) {
    return [];
  }

  const feedbackQuestions = synthesizePendingQuestionsFromFeedback(params.feedbackRequest ?? null);
  const modelingQuestions = synthesizePendingQuestionsFromModeling(params.modeling ?? null);
  if (modelingQuestions.length > feedbackQuestions.length) {
    return modelingQuestions;
  }

  if (feedbackQuestions.length > 0) {
    return feedbackQuestions;
  }

  if (modelingQuestions.length > 0) {
    return modelingQuestions;
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

function normalizeGoalFrame(value: unknown, intake: IntakeResult | null, instruction: string): GoalFrameResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return parseGoalFrameResult(value, intake ?? parseIntakeResult(null, instruction));
}

function normalizeFeedbackQuestion(value: unknown): OperatorFeedbackQuestion | null {
  if (!isRecord(value)) {
    return null;
  }

  const questionId = asTrimmedString(value.questionId);
  const prompt = asTrimmedString(value.prompt);
  if (!questionId || !prompt) {
    return null;
  }

  return {
    questionId,
    label: asTrimmedString(value.label) || questionId,
    prompt,
    whyItMatters: asTrimmedString(value.whyItMatters),
    options: asStringArray(value.options),
    recommendedOption: asTrimmedString(value.recommendedOption) || undefined,
  };
}

function normalizeFeedbackRequest(value: unknown): OperatorFeedbackResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const questions = Array.isArray(value.questions)
    ? value.questions
        .map((question) => normalizeFeedbackQuestion(question))
        .filter((question): question is OperatorFeedbackQuestion => question !== null)
    : [];

  return {
    headline: asTrimmedString(value.headline) || "Operator input needed",
    preface: asTrimmedString(value.preface),
    questions,
    answerInstructions: asTrimmedString(value.answerInstructions),
    suggestedReplyFormat: asTrimmedString(value.suggestedReplyFormat),
  };
}

function normalizeExplanation(value: unknown): ExplanationResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const markdown = asTrimmedString(value.markdown);
  if (!markdown) {
    return null;
  }

  return {
    headline: asTrimmedString(value.headline),
    summary: asTrimmedString(value.summary),
    markdown,
    nextAction: asTrimmedString(value.nextAction),
  };
}

function normalizeModeling(value: unknown): ModelingResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    systemSummary: asTrimmedString(value.systemSummary),
    mermaid: asTrimmedString(value.mermaid),
    keyEntities: asStringArray(value.keyEntities),
    criticalFlows: asStringArray(value.criticalFlows),
    openQuestions: asStringArray(value.openQuestions),
  };
}

function normalizeTestCase(value: unknown): TestDesignCase | null {
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

function normalizeTestDesign(value: unknown): TestDesignResult | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    strategySummary: asTrimmedString(value.strategySummary),
    testCases: Array.isArray(value.testCases)
      ? value.testCases
          .map((testCase) => normalizeTestCase(testCase))
          .filter((testCase): testCase is TestDesignCase => testCase !== null)
      : [],
    verificationChecklist: asStringArray(value.verificationChecklist),
    suggestedCommands: asStringArray(value.suggestedCommands),
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
    const goalFrame = normalizeGoalFrame(parsed.goalFrame, intake, originalInstruction);
    const modeling = normalizeModeling(parsed.modeling);
    const testDesign = normalizeTestDesign(parsed.testDesign);
    let feedbackRequest = normalizeFeedbackRequest(parsed.feedbackRequest);
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
    const synthesizedPendingQuestions = buildPendingQuestions({ result, intake, modeling, feedbackRequest });
    const pendingQuestions = (isFallbackPlanningResult(result) && synthesizedPendingQuestions.length > parsedPendingQuestions.length
        ? synthesizedPendingQuestions
        : parsedPendingQuestions.length > 0
          ? parsedPendingQuestions
          : synthesizedPendingQuestions
    ).filter((question) => {
      const existingAnswer = answers[question.id];
      return !existingAnswer || !existingAnswer.answer.trim();
    });

    if (pendingQuestions.length === 0 && isFallbackPlanningResult(result)) {
      feedbackRequest = null;
    } else if (!feedbackMatchesPendingQuestions(feedbackRequest, pendingQuestions)) {
      feedbackRequest = coerceOperatorFeedbackResult(null, pendingQuestions);
    }

    const createdAt = asTrimmedString(parsed.createdAt) || new Date().toISOString();
    const updatedAt = asTrimmedString(parsed.updatedAt) || createdAt;
    const finalExecutionPrompt = asTrimmedString(parsed.finalExecutionPrompt) || null;
    const explanation = normalizeExplanation(parsed.explanation);
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
      intake,
      goalFrame,
      modeling,
      testDesign,
      feedbackRequest,
      explanation,
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
  goalFrame?: GoalFrameResult | null;
  modeling?: ModelingResult | null;
  testDesign?: TestDesignResult | null;
  feedbackRequest?: OperatorFeedbackResult | null;
  explanation?: ExplanationResult | null;
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
    modeling: params.modeling ?? params.previous?.modeling ?? null,
    feedbackRequest: params.feedbackRequest ?? params.previous?.feedbackRequest ?? null,
  }).filter((question) => {
    const existingAnswer = answers[question.id];
    return !existingAnswer || !existingAnswer.answer.trim();
  });
  let feedbackRequest =
    params.feedbackRequest
    ?? params.previous?.feedbackRequest
    ?? (pendingQuestions.length > 0 ? coerceOperatorFeedbackResult(null, pendingQuestions) : null);
  if (pendingQuestions.length === 0 && isFallbackPlanningResult(params.result)) {
    feedbackRequest = null;
  } else if (!feedbackMatchesPendingQuestions(feedbackRequest, pendingQuestions)) {
    feedbackRequest = coerceOperatorFeedbackResult(null, pendingQuestions);
  }
  const finalExecutionPrompt = params.result.finalExecutionPrompt.trim() || null;
  const status =
    pendingQuestions.length > 0
      ? "needs-answers"
      : finalExecutionPrompt
        ? "ready"
        : "needs-final-prompt";

  return {
    schemaVersion: 4,
    originalInstruction: params.originalInstruction,
    planningThreadId: params.planningThreadId ?? params.previous?.planningThreadId ?? null,
    intake: params.intake ?? params.previous?.intake ?? null,
    goalFrame: params.goalFrame ?? params.previous?.goalFrame ?? null,
    modeling: params.modeling ?? params.previous?.modeling ?? null,
    testDesign: params.testDesign ?? params.previous?.testDesign ?? null,
    feedbackRequest,
    explanation: params.explanation ?? params.previous?.explanation ?? null,
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
  const includeAgentSections = options?.includeAgentSections ?? true;
  const includeRawOutput = options?.includeRawOutput ?? true;
  const intakeSummary = context.intake ? renderIntakeMarkdown(context.intake) : "None recorded.";
  const goalFrameSummary = context.goalFrame ? renderGoalFrameMarkdown(context.goalFrame) : "None recorded.";
  const modelingSummary = context.modeling ? renderModelingMarkdown(context.modeling) : "None recorded.";
  const testDesignSummary = context.testDesign ? renderTestDesignMarkdown(context.testDesign) : "None recorded.";
  const feedbackSummary = context.feedbackRequest ? renderOperatorFeedbackMarkdown(context.feedbackRequest) : "None recorded.";
  const explanationSummary = context.explanation?.markdown ?? "None recorded.";
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
  const agentSections = includeAgentSections
    ? [
        "",
        "Operator feedback request:",
        feedbackSummary,
        "",
        "Discord explanation:",
        explanationSummary,
      ]
    : [];

  return [
    "Structured intake:",
    intakeSummary,
    "",
    "Goal frame:",
    goalFrameSummary,
    "",
    "System model:",
    modelingSummary,
    "",
    "Test design:",
    testDesignSummary,
    ...agentSections,
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
