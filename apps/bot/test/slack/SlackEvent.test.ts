import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { decodeEnvelope, eligibleActivity, SlackActivity } from "../../src/slack/SlackEvent.ts";

const BOT = "UBOT";

const OFFICE = "C-OFFICE";

const context = { botUserId: BOT, officeChannelId: OFFICE };

const envelope = (
  event: Record<string, string | Record<string, string>>,
  overrides: Record<string, number> = {},
) =>
  JSON.stringify({
    envelope_id: "env-1",
    type: "events_api",
    accepts_response_payload: false,
    retry_attempt: 0,
    retry_reason: "",
    payload: { type: "event_callback", event_id: "Ev1", event },
    ...overrides,
  });

const activityOf = (event: Record<string, string | Record<string, string>>) =>
  Option.flatMap(decodeEnvelope(envelope(event)), (decoded) => eligibleActivity(decoded, context));

const threadReply = {
  type: "message",
  channel: OFFICE,
  channel_type: "channel",
  user: "U1",
  text: "Sam is a machine",
  ts: "1700000100.000200",
  thread_ts: "1700000000.000100",
  parent_user_id: BOT,
};

describe("decodeEnvelope", () => {
  it("reads the envelope ID and retry attempt of an event", () => {
    const decoded = Option.getOrThrow(decodeEnvelope(envelope(threadReply, { retry_attempt: 2 })));

    assert.deepStrictEqual(decoded.envelopeId, Option.some("env-1"));
    assert.strictEqual(decoded.type, "events_api");
    assert.strictEqual(decoded.retryAttempt, 2);
  });

  it("reads hello and disconnect messages, which have no envelope ID", () => {
    assert.deepStrictEqual(
      Option.map(
        decodeEnvelope(JSON.stringify({ type: "hello", num_connections: 1 })),
        ({ type }) => type,
      ),
      Option.some("hello"),
    );
    assert.deepStrictEqual(
      Option.map(
        decodeEnvelope(JSON.stringify({ type: "disconnect", reason: "refresh_requested" })),
        ({ type }) => type,
      ),
      Option.some("disconnect"),
    );
  });

  it("still reads the envelope of an event it doesn't know, so it can be acked", () => {
    const decoded = decodeEnvelope(envelope({ type: "channel_rename", channel: OFFICE }));

    assert.deepStrictEqual(
      Option.flatMap(decoded, ({ envelopeId }) => envelopeId),
      Option.some("env-1"),
    );
    assert.isTrue(
      Option.isNone(Option.flatMap(decoded, (event) => eligibleActivity(event, context))),
    );
  });

  it("rejects something that isn't JSON", () => {
    assert.isTrue(Option.isNone(decodeEnvelope("not json")));
  });
});

describe("eligibleActivity", () => {
  it("answers a reply in a thread under one of the bot's posts", () => {
    assert.deepStrictEqual(
      activityOf(threadReply),
      Option.some(
        SlackActivity.Message({
          channel: OFFICE,
          ts: "1700000100.000200",
          threadTs: "1700000000.000100",
          userId: "U1",
          text: "Sam is a machine",
          isMention: false,
        }),
      ),
    );
  });

  it("answers a mention, in a new thread under it when it isn't in one", () => {
    assert.deepStrictEqual(
      activityOf({
        type: "app_mention",
        channel: OFFICE,
        user: "U1",
        text: `<@${BOT}> who's in?`,
        ts: "5.0",
      }),
      Option.some(
        SlackActivity.Message({
          channel: OFFICE,
          ts: "5.0",
          threadTs: "5.0",
          userId: "U1",
          text: `<@${BOT}> who's in?`,
          isMention: true,
        }),
      ),
    );
  });

  it("answers a mention inside a thread in that thread", () => {
    const activity = activityOf({
      type: "app_mention",
      channel: OFFICE,
      user: "U1",
      text: `<@${BOT}> and you?`,
      ts: "6.0",
      thread_ts: "4.0",
    });

    assert.deepStrictEqual(
      Option.map(activity, (found) => (SlackActivity.$is("Message")(found) ? found.threadTs : "")),
      Option.some("4.0"),
    );
  });

  it("leaves a mention in a thread under its post to the mention event", () => {
    assert.isTrue(
      Option.isNone(activityOf({ ...threadReply, text: `<@${BOT}> what do you think?` })),
    );
  });

  it("ignores threads under other people's posts, and top-level messages", () => {
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, parent_user_id: "U9" })));

    const { thread_ts: _thread, parent_user_id: _parent, ...topLevel } = threadReply;

    assert.isTrue(Option.isNone(activityOf(topLevel)));
  });

  it("ignores other channels and DMs, even mentions", () => {
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, channel: "C-ELSEWHERE" })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, channel: "D1", channel_type: "im" })));
    assert.isTrue(
      Option.isNone(
        activityOf({
          type: "app_mention",
          channel: "C-ELSEWHERE",
          user: "U1",
          text: `<@${BOT}>`,
          ts: "5.0",
        }),
      ),
    );
  });

  it("ignores the bot itself, other bots, edits, deletions and joins", () => {
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, user: BOT })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, bot_id: "B2" })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, subtype: "message_changed" })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, subtype: "message_deleted" })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, subtype: "channel_join" })));
    assert.isTrue(Option.isNone(activityOf({ ...threadReply, subtype: "thread_broadcast" })));
  });

  it("keeps reactions added to and removed from the bot's posts", () => {
    const reaction = {
      type: "reaction_added",
      user: "U1",
      reaction: "joy",
      item_user: BOT,
      item: { type: "message", channel: OFFICE, ts: "1.0" },
      event_ts: "7.0",
    };

    assert.deepStrictEqual(
      activityOf(reaction),
      Option.some(
        SlackActivity.Reaction({
          channel: OFFICE,
          itemTs: "1.0",
          userId: "U1",
          emoji: "joy",
          added: true,
          eventTs: "7.0",
        }),
      ),
    );
    assert.deepStrictEqual(
      Option.map(activityOf({ ...reaction, type: "reaction_removed" }), (found) =>
        SlackActivity.$is("Reaction")(found) ? found.added : true,
      ),
      Option.some(false),
    );
  });

  it("ignores reactions to other people's messages, in other channels, or by the bot", () => {
    const reaction = {
      type: "reaction_added",
      user: "U1",
      reaction: "joy",
      item_user: BOT,
      item: { type: "message", channel: OFFICE, ts: "1.0" },
      event_ts: "7.0",
    };

    assert.isTrue(Option.isNone(activityOf({ ...reaction, item_user: "U2" })));
    assert.isTrue(
      Option.isNone(
        activityOf({ ...reaction, item: { type: "message", channel: "C2", ts: "1.0" } }),
      ),
    );
    assert.isTrue(Option.isNone(activityOf({ ...reaction, user: BOT })));
  });
});
