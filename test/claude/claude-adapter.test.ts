import { describe, expect, it } from "vitest";
import { buildClaudePrintArgs, parseClaudeStreamLine } from "../../src/claude/claude-adapter.js";

describe("parseClaudeStreamLine", () => {
  it("parses streamed text deltas", () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: "content_block_delta",
      delta: { text: "Hello" },
    }));

    expect(event).toEqual({
      kind: "delta",
      text: "Hello",
    });
  });

  it("parses final result payloads", () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: "result",
      result: "Done",
    }));

    expect(event).toEqual({
      kind: "final",
      text: "Done",
    });
  });

  it("falls back to plain text lines", () => {
    const event = parseClaudeStreamLine("plain text");
    expect(event).toEqual({
      kind: "delta",
      text: "plain text",
    });
  });

  it("surfaces error payloads", () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: "error",
      message: "boom",
    }));

    expect(event).toEqual({
      kind: "error",
      message: "boom",
    });
  });
});

describe("buildClaudePrintArgs", () => {
  it("includes budget, schema, tool limits, session, and bounded directory flags", () => {
    const args = buildClaudePrintArgs({
      addDirs: ["C:/repo"],
      model: "haiku",
      permissionMode: "plan",
      systemPrompt: "Be bounded.",
      maxBudgetUsd: 0.25,
      jsonSchema: { type: "object" },
      tools: ["Read", "Grep"],
      allowedTools: ["Read"],
      disallowedTools: ["Write", "WebSearch"],
      noSessionPersistence: true,
    });

    expect(args).toEqual(expect.arrayContaining([
      "--model",
      "haiku",
      "--permission-mode",
      "plan",
      "--system-prompt",
      "Be bounded.",
      "--no-session-persistence",
      "--max-budget-usd",
      "0.25",
      "--json-schema",
      JSON.stringify({ type: "object" }),
      "--tools",
      "Read,Grep",
      "--allowedTools",
      "Read",
      "--disallowedTools",
      "Write,WebSearch",
      "--add-dir",
      "C:/repo",
    ]));
  });
});
