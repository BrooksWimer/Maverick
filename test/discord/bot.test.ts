import { describe, expect, it } from "vitest";
import {
  buildAttachedTextReply,
  parsePlanningAnswerInput,
  persistedEpicIdForResolvedEpic,
  shouldAttachReplyPreview,
  shouldPostPlanGeneratedMessage,
  splitDiscordMessageContent,
} from "../../src/discord/bot.js";

describe("persistedEpicIdForResolvedEpic", () => {
  it("omits the synthetic default lane from persisted epic ids", () => {
    expect(
      persistedEpicIdForResolvedEpic({
        id: "default",
        source: "default",
      })
    ).toBeUndefined();
  });

  it("preserves configured epic ids for routed or explicit epic workstreams", () => {
    expect(
      persistedEpicIdForResolvedEpic({
        id: "router-admin-ingestion",
        source: "route",
      })
    ).toBe("router-admin-ingestion");

    expect(
      persistedEpicIdForResolvedEpic({
        id: "startup-mic-auto-alignment",
        source: "explicit",
      })
    ).toBe("startup-mic-auto-alignment");
  });
});

describe("shouldAttachReplyPreview", () => {
  it("attaches when the preview body had to be truncated even if the inline message still fits", () => {
    expect(shouldAttachReplyPreview(["Stored Claude plan."], "a".repeat(1400), 1200)).toBe(true);
  });

  it("keeps short content inline when nothing was truncated", () => {
    expect(shouldAttachReplyPreview(["Stored Claude plan."], "short plan", 1200)).toBe(false);
  });
});

describe("buildAttachedTextReply", () => {
  it("renders markdown bodies directly into the Discord message content", () => {
    const reply = buildAttachedTextReply({
      headerLines: ["Workstream status:"],
      body: "# Workstream Status\n\n## Summary\n- State: planning",
      attachmentName: "workstream-status.md",
      attachmentNotice: "Full status attached.",
    });

    expect(reply.content).toBe("# Workstream Status\n\n## Summary\n- State: planning");
    expect(reply.files).toBeUndefined();
  });

  it("falls back to header plus body for plain text replies", () => {
    const reply = buildAttachedTextReply({
      headerLines: ["Workstream status:"],
      body: "State: planning",
      previewLimit: 1500,
      attachmentName: "workstream-status.md",
      attachmentNotice: "Full status attached.",
    });

    expect(reply.content).toBe("Workstream status:\n\nState: planning");
    expect(reply.files).toBeUndefined();
  });
});

describe("splitDiscordMessageContent", () => {
  it("splits long rendered markdown into multiple safe Discord messages", () => {
    const content = "# Title\n\n" + Array.from({ length: 300 }, (_, index) => `- item ${index}`).join("\n");
    const chunks = splitDiscordMessageContent(content, 400);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks[0]).toContain("# Title");
  });
});

describe("shouldPostPlanGeneratedMessage", () => {
  it("posts manual and resume plan results when no operator questions remain", () => {
    expect(shouldPostPlanGeneratedMessage({ needsAnswers: false })).toBe(true);
  });

  it("does not duplicate question-gated planning messages", () => {
    expect(shouldPostPlanGeneratedMessage({ needsAnswers: true })).toBe(false);
  });
});

describe("parsePlanningAnswerInput", () => {
  it("parses multiline slash-command answers", () => {
    expect(
      parsePlanningAnswerInput("discord-ux: Use /workstream answer-plan.\nstate-model = Keep planning state on the workstream.")
    ).toEqual({
      answers: {
        "discord-ux": "Use /workstream answer-plan.",
        "state-model": "Keep planning state on the workstream.",
      },
      invalidLines: [],
    });
  });

  it("reports malformed lines", () => {
    expect(parsePlanningAnswerInput("missing separator\nok: value").invalidLines).toEqual(["missing separator"]);
  });
});
