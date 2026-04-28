import { describe, expect, it } from "vitest";
import {
  buildWorkstreamEpicChoices,
  buildPlanNotificationMessages,
  buildAttachedTextReply,
  parsePlanningAnswerInput,
  parseWorkstreamEpicChoice,
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

    expect(
      persistedEpicIdForResolvedEpic({
        id: "default",
        source: "route",
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

describe("workstream epic choices", () => {
  it("includes durable default lanes as selectable workstream lanes", () => {
    const choices = buildWorkstreamEpicChoices({
      projects: [
        {
          id: "portfolio-resume",
          name: "Portfolio & Resume",
          epicBranches: [],
          defaultLanes: [
            { id: "portfolio", baseBranch: "portfolio" },
            { id: "resume", baseBranch: "resume" },
          ],
        },
        {
          id: "netwise",
          name: "Astra",
          epicBranches: [{ id: "router-admin-ingestion", branch: "codex/router-admin-ingestion-epic" }],
          defaultLanes: [],
        },
      ],
    } as any);

    expect(choices).toContainEqual({
      name: "Portfolio & Resume: portfolio",
      value: "portfolio-resume:lane:portfolio",
    });
    expect(choices).toContainEqual({
      name: "Portfolio & Resume: resume",
      value: "portfolio-resume:lane:resume",
    });
    expect(choices).toContainEqual({
      name: "Astra: router-admin-ingestion",
      value: "netwise:epic:router-admin-ingestion",
    });
  });

  it("parses lane and legacy epic choices", () => {
    expect(parseWorkstreamEpicChoice("portfolio-resume:lane:portfolio")).toEqual({
      projectId: "portfolio-resume",
      epicId: "portfolio",
      kind: "lane",
    });
    expect(parseWorkstreamEpicChoice("netwise:router-admin-ingestion")).toEqual({
      projectId: "netwise",
      epicId: "router-admin-ingestion",
      kind: "epic",
    });
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

describe("buildPlanNotificationMessages", () => {
  it("sends the full rendered plan first and the formatted summary second when they differ", () => {
    const messages = buildPlanNotificationMessages({
      workstreamName: "Portfolio Refresh",
      instruction: "Update the portfolio and resume.",
      renderedPlan: "## Full Plan\n\n- Step 1\n- Step 2",
      formattedMarkdown: "## Quick Take\n\n- Focus on Maverick and Netwise\n- Verify rendered output",
      finalExecutionPrompt: "Run the stored prompt.",
      needsAnswers: false,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("Planning Ready - Portfolio Refresh");
    expect(messages[0]?.content).toContain("## Full Plan");
    expect(messages[1]?.content).toContain("# Planning Summary - Portfolio Refresh");
    expect(messages[1]?.content).toContain("## Quick Take");
  });

  it("avoids sending a duplicate summary when formatted markdown matches the rendered plan", () => {
    const messages = buildPlanNotificationMessages({
      workstreamName: "Portfolio Refresh",
      instruction: "Update the portfolio and resume.",
      renderedPlan: "## Full Plan\n\n- Step 1\n- Step 2",
      formattedMarkdown: "## Full Plan\n\n- Step 1\n- Step 2",
      finalExecutionPrompt: null,
      needsAnswers: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("Planning Questions - Portfolio Refresh");
  });

  it("adds guided answer buttons and visible question ids for pending planning questions", () => {
    const messages = buildPlanNotificationMessages({
      workstreamId: "5cd5405d-c8b1-424b-9dee-73e61e51efef",
      workstreamName: "Portfolio Refresh",
      instruction: "Update the portfolio and resume.",
      renderedPlan: "## Full Plan\n\n- Waiting on answers",
      formattedMarkdown: "## Quick Take\n\n- Waiting on answers",
      finalExecutionPrompt: null,
      needsAnswers: true,
      questions: [
        {
          id: "open-question-1",
          question: "What is the current employer?",
          whyItMatters: "The bio needs current employment status.",
          options: [],
          kind: "required-answer",
        },
        {
          id: "open-question-2",
          question: "What email address should replace the old one?",
          whyItMatters: "The contact section needs a current address.",
          options: [],
          kind: "required-answer",
        },
      ],
    });

    expect(messages[0]?.content).toContain("`open-question-1`");
    expect(messages[0]?.content).toContain("Use the buttons below");
    expect(messages[0]?.components).toHaveLength(1);
  });

  it("skips stale formatted summaries that do not match the current pending question ids", () => {
    const messages = buildPlanNotificationMessages({
      workstreamId: "5cd5405d-c8b1-424b-9dee-73e61e51efef",
      workstreamName: "Portfolio Refresh",
      instruction: "Update the portfolio and resume.",
      renderedPlan: "Pending planning questions:\n1. open-question-1\n2. open-question-2",
      formattedMarkdown: "## Old Summary\n\n1. `clarification-2`\n2. `clarification-4`",
      finalExecutionPrompt: null,
      needsAnswers: true,
      questions: [
        {
          id: "open-question-1",
          question: "What is the current employer?",
          whyItMatters: "The bio needs current employment status.",
          options: [],
          kind: "required-answer",
        },
        {
          id: "open-question-2",
          question: "What email address should replace the old one?",
          whyItMatters: "The contact section needs a current address.",
          options: [],
          kind: "required-answer",
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).not.toContain("Old Summary");
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
