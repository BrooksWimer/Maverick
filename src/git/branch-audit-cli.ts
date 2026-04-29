import { loadConfig } from "../config/index.js";
import { auditRemoteBranches, createMissingRemoteBranches, type BranchRepairResult } from "./branch-audit.js";

const args = new Set(process.argv.slice(2));
const repair = args.has("--repair");
const skipSyncSonic = !args.has("--include-syncsonic");

const configPathArg = process.argv.find((arg) => arg.startsWith("--config="));
const config = loadConfig(configPathArg?.slice("--config=".length));

for (const project of config.projects) {
  if (skipSyncSonic && project.id === "syncsonic") {
    console.log(`[deferred] ${project.id}: SyncSonic branch state intentionally skipped`);
    continue;
  }

  const result = repair
    ? await createMissingRemoteBranches(project)
    : await auditRemoteBranches(project);

  const present = result.present.map((branch) => branch.branch).join(", ") || "none";
  const missing = result.missing.map((branch) => branch.branch).join(", ") || "none";
  console.log(`[${project.id}] present: ${present}`);
  console.log(`[${project.id}] missing: ${missing}`);

  if (repair) {
    const repaired = result as BranchRepairResult;
    const created = repaired.created.map((branch) => branch.branch).join(", ") || "none";
    const skipped = repaired.skipped.map((branch) => branch.branch).join(", ") || "none";
    console.log(`[${project.id}] created: ${created}`);
    console.log(`[${project.id}] skipped: ${skipped}`);
  }
}
