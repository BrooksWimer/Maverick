#!/usr/bin/env node
import Database from "better-sqlite3";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPlanningContextRecord,
  parsePlanningContextRecord,
  renderPlanningSummary,
  structureRawPlanningOutput,
} from "../dist/agents/planning-support.js";
import { coerceExplanationResult } from "../dist/agents/response-formatting-support.js";

function argValue(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readIfExists(path) {
  if (!existsSync(path)) {
    return "";
  }
  return readFileSync(path, "utf8");
}

function readSupplementalDocs(project, workstream, instruction) {
  const repoPath = project.repo_path;
  const docs = [
    readIfExists(resolve(repoPath, "docs", "maverick", "PROJECT_CONTEXT.md")),
    workstream.epic_id
      ? readIfExists(resolve(repoPath, "docs", "maverick", "epics", `${workstream.epic_id}.md`))
      : "",
  ];

  const planDir = resolve(repoPath, "docs", "maverick", "plans");
  if (existsSync(planDir)) {
    const preferredSlugs = new Set([
      slugify(workstream.name),
      slugify(instruction),
      workstream.epic_id ? slugify(workstream.epic_id) : "",
    ].filter(Boolean));
    for (const entry of readdirSync(planDir)) {
      if (!entry.toLowerCase().endsWith(".md")) {
        continue;
      }
      const stem = entry.replace(/\.md$/i, "");
      if (preferredSlugs.size > 0 && !preferredSlugs.has(stem)) {
        continue;
      }
      docs.push(readIfExists(resolve(planDir, entry)));
    }
  }

  return docs.filter((doc) => doc.trim());
}

const workstreamId = argValue("--workstream") ?? argValue("-w");
const dbPath = argValue("--db") ?? "data/orchestrator.db";
const shouldWrite = process.argv.includes("--write");

if (!workstreamId) {
  console.error("Usage: node scripts/structure-plan-output.mjs --workstream <id> [--write] [--db data/orchestrator.db]");
  process.exit(2);
}

const db = new Database(dbPath);
const workstream = db.prepare("SELECT * FROM workstreams WHERE id = ?").get(workstreamId);
if (!workstream) {
  throw new Error(`Workstream not found: ${workstreamId}`);
}

const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(workstream.project_id);
if (!project) {
  throw new Error(`Project not found: ${workstream.project_id}`);
}

const existingContext = parsePlanningContextRecord(workstream.planning_context_json);
if (!existingContext) {
  throw new Error(`Workstream has no stored planning context: ${workstreamId}`);
}

const result = structureRawPlanningOutput({
  originalInstruction: existingContext.originalInstruction,
  rawAgentOutput: existingContext.rawAgentOutput,
  contextBundle: existingContext.contextBundle,
  supplementalDocs: readSupplementalDocs(project, workstream, existingContext.originalInstruction),
});

if (!result) {
  throw new Error("Raw planning output could not be structured deterministically.");
}

const baseContext = buildPlanningContextRecord({
  originalInstruction: existingContext.originalInstruction,
  result,
  rawAgentOutput: existingContext.rawAgentOutput,
  contextBundle: existingContext.contextBundle,
  intake: existingContext.intake,
  goalFrame: existingContext.goalFrame,
  modeling: existingContext.modeling,
  testDesign: existingContext.testDesign,
  answers: existingContext.answers,
  planningThreadId: existingContext.planningThreadId,
  previous: existingContext,
});
const explanation = coerceExplanationResult(null, baseContext, baseContext.feedbackRequest);
const structuredContext = buildPlanningContextRecord({
  originalInstruction: existingContext.originalInstruction,
  result,
  rawAgentOutput: existingContext.rawAgentOutput,
  contextBundle: existingContext.contextBundle,
  intake: existingContext.intake,
  goalFrame: existingContext.goalFrame,
  modeling: existingContext.modeling,
  testDesign: existingContext.testDesign,
  feedbackRequest: baseContext.feedbackRequest,
  explanation,
  answers: existingContext.answers,
  planningThreadId: existingContext.planningThreadId,
  previous: existingContext,
});

const renderedPlan = renderPlanningSummary(structuredContext);
console.log(JSON.stringify({
  workstreamId,
  workstreamName: workstream.name,
  status: structuredContext.status,
  finalExecutionPromptReady: Boolean(structuredContext.finalExecutionPrompt),
  finalExecutionPrompt: structuredContext.finalExecutionPrompt,
  steps: structuredContext.result.steps.map((step) => step.description),
  testStrategy: structuredContext.result.testStrategy,
  dryRun: !shouldWrite,
}, null, 2));

if (shouldWrite) {
  const pendingDecision = structuredContext.status === "needs-answers"
    ? JSON.stringify({
        source: "planning",
        status: "needs-answers",
        questions: structuredContext.pendingQuestions,
      })
    : structuredContext.status === "needs-final-prompt"
      ? JSON.stringify({
          source: "planning",
          status: "needs-final-prompt",
          description: "Planning has no final execution prompt yet.",
        })
      : null;
  const summary = structuredContext.finalExecutionPrompt
    ? "Planning produced a final Codex execution prompt."
    : "Planning stored structured analysis, but no final execution prompt is ready yet.";

  db.prepare(`
    UPDATE workstreams
    SET current_goal = ?,
        pending_decision = ?,
        planning_context_json = ?,
        plan = ?,
        summary = ?,
        updated_at = datetime('now'),
        last_activity_at = datetime('now')
    WHERE id = ?
  `).run(
    structuredContext.originalInstruction,
    pendingDecision,
    JSON.stringify(structuredContext),
    renderedPlan,
    summary,
    workstreamId,
  );
  db.prepare(`
    INSERT INTO events (workstream_id, project_id, event_type, payload_json, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    workstreamId,
    workstream.project_id,
    "plan.structured",
    JSON.stringify({
      trigger: "deterministic-structurer",
      finalPromptReady: Boolean(structuredContext.finalExecutionPrompt),
    }),
    "script",
  );
}
