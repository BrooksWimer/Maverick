import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvironment } from "../config/env.js";
import { CodexAppServerAdapter } from "./app-server-adapter.js";

loadEnvironment();

async function main() {
  const adapter = new CodexAppServerAdapter({
    transport: "stdio",
    model: process.env.CODEX_MODEL,
    codexJsPath: process.env.CODEX_JS_PATH,
    nodePath: process.env.CODEX_NODE_PATH,
  });

  await adapter.initialize();

  const threadsBefore = await adapter.listThreads();
  const tempCwd = mkdtempSync(join(tmpdir(), "maverick-smoke-"));
  const thread = await adapter.createThread(tempCwd);
  const threadRecord = await adapter.readThread(thread.id, false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        transport: "stdio",
        threadsBefore: threadsBefore.length,
        createdThreadId: thread.id,
        createdThreadCwd: thread.cwd,
        readBackId: threadRecord.id,
        readBackCwd: threadRecord.cwd,
      },
      null,
      2
    )
  );

  await adapter.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
