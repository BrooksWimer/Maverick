import { describe, expect, it } from "vitest";
import {
  parsePlanningAnswerInput,
  persistedEpicIdForResolvedEpic,
  shouldAttachReplyPreview,
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
