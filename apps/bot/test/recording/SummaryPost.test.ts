import { Array, DateTime, Option, String } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ActionItemList } from "../../src/recording/ActionItems.ts";
import { rewriteNote, summaryMessage } from "../../src/recording/SummaryPost.ts";
import { AI_DISCLAIMER } from "../../src/slack/SlackMessage.ts";

// 2026-09-25T14:05:00Z
const at = DateTime.makeUnsafe(1_790_345_100_000);

const office = { guildId: "g1", channelId: "c1" };

describe("summaryMessage", () => {
  const recording = {
    office,
    startedAt: at,
    stoppedAt: DateTime.add(at, { minutes: 95 }),
    startedByName: "Ada <3",
    title: null,
    speakers: ["Ada <3", "Grace"],
    summary: Option.some({
      text: "• Ada & Grace agreed to ship",
      model: "nvidia/nemotron",
      style: "brief" as const,
    }),
    actionItems: ActionItemList.NotTried(),
  };

  const actionItemsText = (actionItems: ActionItemList) =>
    Array.flatMap(summaryMessage({ ...recording, actionItems }).blocks, (block) =>
      block.type === "section" &&
      block.text !== undefined &&
      String.startsWith("*Action items*")(block.text.text)
        ? [block.text.text]
        : [],
    );

  it("leads with when and how long, then the summary, who started it and who spoke", () => {
    const message = summaryMessage(recording);
    const card = JSON.stringify(message.blocks);

    expect(message.text).toBe("📝 Office recording, 1h 35m");
    expect(card).toContain(
      "📝 *Office recording* from <!date^1790345100^{date_short} {time}|2026-09-25 14:05 UTC>, 1h 35m",
    );
    expect(card).toContain("• Ada &amp; Grace agreed to ship");
    expect(card).toContain("*Started by*\\nAda &lt;3");
    expect(card).toContain("*Who spoke*\\nAda &lt;3, Grace");
    expect(card).toContain("✨ Brief summary by nvidia/nemotron");
    expect(card).toContain("📄 Full transcript in the thread");
    expect(card).toContain(AI_DISCLAIMER);
  });

  it("heads the post with the title and notifies with it when the recording has one", () => {
    const message = summaryMessage({ ...recording, title: "Deploy <retro> & beers" });
    const card = JSON.stringify(message.blocks);

    expect(message.text).toBe("📝 Deploy &lt;retro&gt; &amp; beers, 1h 35m");
    expect(card).toContain(
      "📝 *Deploy &lt;retro&gt; &amp; beers* · <!date^1790345100^{date_short} {time}|2026-09-25 14:05 UTC>, 1h 35m",
    );
    expect(card).not.toContain("Office recording");
  });

  it("says so when no model could write a summary", () => {
    const card = JSON.stringify(
      summaryMessage({ ...recording, summary: Option.none(), speakers: [] }).blocks,
    );

    expect(card).toContain("No AI model could write a summary this time");
    expect(card).toContain("*Who spoke*\\nNobody");
    expect(card).not.toContain("summary by");
    expect(card).not.toContain(AI_DISCLAIMER);
  });

  it("lists the action items in their own block right below the summary, done ones struck through", () => {
    const actionItems = ActionItemList.Pulled({
      items: [
        { id: 1, text: "write up the deploy checklist", ownerName: "Anna", done: false },
        { id: 2, text: "ask IT about the <VPN>", ownerName: null, done: false },
        { id: 3, text: "book the room for Thursday", ownerName: "Ben & co", done: true },
      ],
    });

    expect(actionItemsText(actionItems)).toEqual([
      "*Action items*\n• Anna: write up the deploy checklist\n• Unassigned: ask IT about the &lt;VPN&gt;\n~• Ben &amp; co: book the room for Thursday~ ✅",
    ]);

    const blocks = summaryMessage({ ...recording, actionItems }).blocks;
    expect(JSON.stringify(blocks[1])).toContain("agreed to ship");
    expect(JSON.stringify(blocks[2])).toContain("*Action items*");
  });

  it("says when nobody took anything on, and when no model could pull the action items out", () => {
    expect(actionItemsText(ActionItemList.Pulled({ items: [] }))).toEqual([
      "*Action items*\nNobody took anything on",
    ]);
    expect(actionItemsText(ActionItemList.Failed())).toEqual([
      "*Action items*\nNo action items could be pulled out",
    ]);
  });

  it("has no action items block for a recording from before they were pulled out", () => {
    expect(actionItemsText(ActionItemList.NotTried())).toEqual([]);
    expect(summaryMessage(recording).blocks).toHaveLength(4);
  });

  it("names the style the summary was written in", () => {
    const styled = (style: "detailed" | "decisions") =>
      JSON.stringify(
        summaryMessage({
          ...recording,
          summary: Option.some({ text: "• Shipped", model: "nvidia/nemotron", style }),
        }).blocks,
      );

    expect(styled("detailed")).toContain("✨ Detailed summary by nvidia/nemotron");
    expect(styled("decisions")).toContain("✨ Decisions &amp; actions summary by nvidia/nemotron");
  });
});

describe("rewriteNote", () => {
  it("says who rewrote the summary, and the new style when it changed", () => {
    expect(rewriteNote(Option.some("detailed"), "Ben")).toEqual({
      text: "✨ Summary rewritten as Detailed by Ben",
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "✨ Summary rewritten as Detailed by Ben" }],
        },
      ],
    });
    expect(rewriteNote(Option.none(), "Ben <3").text).toBe("✨ Summary rewritten by Ben &lt;3");
    expect(rewriteNote(Option.some("decisions"), "Ben").text).toBe(
      "✨ Summary rewritten as Decisions &amp; actions by Ben",
    );
  });
});
