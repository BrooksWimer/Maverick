import { describe, expect, it } from "vitest";
import { parseClaudeStreamLine } from "../../src/claude/claude-adapter.js";

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
