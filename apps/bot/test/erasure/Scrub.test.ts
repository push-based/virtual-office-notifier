import { assert, describe, it } from "@effect/vitest";

import { scrubberFor } from "../../src/erasure/Scrub.ts";

describe("scrubberFor", () => {
  const scrubber = scrubberFor(["Ada", "Ada Lovelace", " ", "a former member"], ["U123"]);

  it("replaces whole names, longest first, as they're written", () => {
    assert.strictEqual(
      scrubber.text("Ada Lovelace said Ada would ask Ada's team, not Adam or Lovelace."),
      "a former member said a former member would ask a former member's team, not Adam or Lovelace.",
    );
  });

  it("finds someone by their first name, but not the same word in lower case", () => {
    const will = scrubberFor(["Will Turner"], []);

    assert.strictEqual(
      will.text("Will said he will ship it"),
      "a former member said he will ship it",
    );
  });

  it("leaves names shorter than three letters alone", () => {
    assert.strictEqual(scrubberFor(["Al"], []).text("Al is here"), "Al is here");
  });

  it("replaces Slack mentions, with or without a label", () => {
    assert.strictEqual(
      scrubber.text("thanks <@U123> and <@U123|ada>, cc <@U999>"),
      "thanks a former member and a former member, cc <@U999>",
    );
  });

  it("finds names escaped for Slack", () => {
    const escaped = scrubberFor(["Tom & Jerry"], []);

    assert.strictEqual(
      escaped.text("*Tom &amp; Jerry* opened the office"),
      "*a former member* opened the office",
    );
  });

  it("gives lower-case needles for finding candidate rows", () => {
    assert.deepStrictEqual(scrubber.needles, ["ada lovelace", "ada", "<@u123"]);
  });

  it("leaves text alone when there's nobody to look for", () => {
    const nobody = scrubberFor([], []);

    assert.deepStrictEqual(nobody.needles, []);
    assert.isFalse(nobody.mentions("Ada"));
    assert.strictEqual(nobody.text("Ada"), "Ada");
  });

  it("leaves links and IDs in a message's blocks alone", () => {
    const linked = [
      {
        type: "actions",
        block_id: "Ada",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Join Ada" }, url: "https://x/Ada" },
        ],
      },
    ];

    assert.deepStrictEqual(scrubber.blocks(linked), [
      {
        type: "actions",
        block_id: "Ada",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Join a former member" },
            url: "https://x/Ada",
          },
        ],
      },
    ]);
    assert.isFalse(scrubber.touches([{ type: "section", block_id: "Ada" }]));
  });

  it("scrubs every string in stored JSON", () => {
    assert.deepStrictEqual(scrubber.json({ kind: "title", title: "Ada's plan" }), {
      kind: "title",
      title: "a former member's plan",
    });
  });

  it("scrubs the text in a message's blocks and drops images of them", () => {
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Ada* opened the office" },
        accessory: { type: "image", image_url: "https://cdn/ada.png", alt_text: "Ada" },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Grace* is in" },
        accessory: { type: "image", image_url: "https://cdn/grace.png", alt_text: "Grace" },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Who came by: Ada, Grace" }] },
    ];

    assert.deepStrictEqual(scrubber.blocks(blocks), [
      { type: "section", text: { type: "mrkdwn", text: "*a former member* opened the office" } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Grace* is in" },
        accessory: { type: "image", image_url: "https://cdn/grace.png", alt_text: "Grace" },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Who came by: a former member, Grace" }],
      },
    ]);
  });
});
