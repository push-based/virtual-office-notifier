import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { AccessRevoked, InvalidPayload, RateLimited, SlackClient, Transport, Unavailable } from "../src/SlackClient.ts";
import {
  makeFakeSlackHttp,
  networkDown,
  type Reply,
  requestJson,
  requestText,
  respond,
  SLACK_ENV,
  slackError,
  slackOk,
  withEnv,
} from "./fakes.ts";

const makeClient = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const http = yield* makeFakeSlackHttp(replies);

  const client = yield* Effect.service(SlackClient).pipe(
    Effect.provide(SlackClient.layerNoDeps.pipe(Layer.provide(http.layer))),
    withEnv(SLACK_ENV),
  );

  return { client, requests: http.requests };
});

const message = { channel: "C-OFFICE", text: "hello", blocks: [] };

describe("SlackClient", () => {
  it.effect("posts with the bot token and returns where the message landed", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([slackOk({ channel: "C-OFFICE", ts: "1700000000.000100" })]);

      const posted = yield* slack.client.postMessage({ ...message, threadTs: "1699999999.000100" });

      assert.deepStrictEqual(posted, { channel: "C-OFFICE", ts: "1700000000.000100" });

      const [request] = yield* slack.requests;
      assert.strictEqual(request?.url, "https://slack.com/api/chat.postMessage");
      assert.strictEqual(request?.headers["authorization"], `Bearer ${SLACK_ENV.SLACK_BOT_TOKEN}`);
      assert.deepStrictEqual(requestJson(request!), {
        channel: "C-OFFICE",
        text: "hello",
        blocks: [],
        thread_ts: "1699999999.000100",
      });
    }));

  it.effect("uploads a file into a thread in Slack's three steps", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([
        slackOk({ upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F123" }),
        respond(200, "OK - 12"),
        slackOk(),
      ]);

      yield* slack.client.uploadFile({
        channel: "C-OFFICE",
        threadTs: "1700000000.000100",
        filename: "transcript.txt",
        title: "Transcript",
        content: new TextEncoder().encode("hello world!"),
      });

      const [getUrl, upload, complete] = yield* slack.requests;
      assert.strictEqual(getUrl?.url, "https://slack.com/api/files.getUploadURLExternal");
      assert.deepStrictEqual(
        [...(getUrl?.urlParams ?? [])],
        [
          ["filename", "transcript.txt"],
          ["length", "12"],
        ],
      );
      assert.strictEqual(upload?.url, "https://files.slack.com/upload/v1/abc");
      assert.isUndefined(upload?.headers["authorization"]);
      assert.strictEqual(requestText(upload!), "hello world!");
      assert.strictEqual(complete?.url, "https://slack.com/api/files.completeUploadExternal");
      assert.deepStrictEqual(requestJson(complete!), {
        files: [{ id: "F123", title: "Transcript" }],
        channel_id: "C-OFFICE",
        thread_ts: "1700000000.000100",
      });
    }));

  it.effect("opens a Socket Mode connection with the app token", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([slackOk({ url: "wss://wss-primary.slack.com/link/?ticket=abc" })]);

      assert.strictEqual(yield* slack.client.openConnection, "wss://wss-primary.slack.com/link/?ticket=abc");

      const [request] = yield* slack.requests;
      assert.strictEqual(request?.url, "https://slack.com/api/apps.connections.open");
      assert.strictEqual(request?.headers["authorization"], `Bearer ${SLACK_ENV.SLACK_APP_TOKEN}`);
    }));

  it.effect("reads a thread oldest first, with who wrote each message", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([
        slackOk({
          messages: [
            { ts: "1.0", user: "UBOT", bot_id: "B1", text: "🐦 Sam was first in again" },
            { ts: "2.0", user: "U1", text: "Sam is a machine" },
            { ts: "3.0", subtype: "channel_join", user: "U2", text: "joined" },
          ],
        }),
      ]);

      const thread = yield* slack.client.threadReplies("C-OFFICE", "1.0");

      assert.deepStrictEqual(thread, [
        { ts: "1.0", userId: "UBOT", text: "🐦 Sam was first in again" },
        { ts: "2.0", userId: "U1", text: "Sam is a machine" },
      ]);

      const [request] = yield* slack.requests;
      assert.include(request?.url, "https://slack.com/api/conversations.replies");
      assert.deepStrictEqual(request?.urlParams.params, [
        ["channel", "C-OFFICE"],
        ["ts", "1.0"],
        ["limit", "1000"],
      ]);
    }));

  it.effect("reads someone's names, preferring the display name", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([
        slackOk({ user: { id: "U1", real_name: "Ada Lovelace", profile: { display_name: "", real_name: "Ada Lovelace" } } }),
      ]);

      assert.deepStrictEqual(yield* slack.client.userProfile("U1"), {
        displayName: "Ada Lovelace",
        realName: "Ada Lovelace",
      });
    }));

  it.effect("learns the bot's own user ID", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([slackOk({ user_id: "UBOT" })]);

      assert.strictEqual(yield* slack.client.botUserId, "UBOT");
    }));

  it.effect("treats a reaction that's already there as added", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([slackError("already_reacted")]);

      yield* slack.client.addReaction("C-OFFICE", "2.0", "joy");

      const [request] = yield* slack.requests;
      assert.deepStrictEqual(requestJson(request!), { channel: "C-OFFICE", timestamp: "2.0", name: "joy" });
    }));

  it.effect.each(["invalid_auth", "token_revoked", "account_inactive", "channel_not_found", "not_in_channel"])(
    "fails without retrying when Slack says %s",
    (code) =>
      Effect.gen(function* () {
        const slack = yield* makeClient([slackError(code)]);

        const { reason } = yield* slack.client.postMessage(message).pipe(Effect.flip);

        assert.instanceOf(reason, AccessRevoked);
        assert.strictEqual(reason.error, code);
        assert.strictEqual((yield* slack.requests).length, 1);
      }),
  );

  it.effect("fails without retrying on any other Slack error", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([slackError("invalid_blocks")]);

      const { reason } = yield* slack.client.postMessage(message).pipe(Effect.flip);

      assert.instanceOf(reason, InvalidPayload);
      assert.strictEqual(reason.error, "invalid_blocks");
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("fails without retrying when Slack's reply makes no sense", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([respond(200, "<html>")]);

      const { reason } = yield* slack.client.postMessage(message).pipe(Effect.flip);

      assert.instanceOf(reason, InvalidPayload);
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("waits for Retry-After when Slack says ratelimited", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([
        slackError("ratelimited", { "retry-after": "5" }),
        slackOk({ channel: "C-OFFICE", ts: "1.0" }),
      ]);

      const fiber = yield* slack.client.postMessage(message).pipe(Effect.forkChild);

      yield* TestClock.adjust("4 seconds");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);
    }));

  it.effect("treats a 429 as rate limited too", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([respond(429, "", { "retry-after": "3" })]);

      const fiber = yield* slack.client.postMessage(message).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const { reason } = yield* Fiber.join(fiber);

      assert.instanceOf(reason, RateLimited);
    }));

  it.effect("retries when Slack is down, then gives up after 4 retries", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([respond(503, "")]);

      const fiber = yield* slack.client.postMessage(message).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const { reason } = yield* Fiber.join(fiber);

      assert.instanceOf(reason, Unavailable);
      assert.strictEqual((yield* slack.requests).length, 5);
    }));

  it.effect("retries network errors without leaking the tokens", () =>
    Effect.gen(function* () {
      const slack = yield* makeClient([networkDown]);

      const fiber = yield* slack.client.postMessage(message).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(fiber);

      assert.instanceOf(error.reason, Transport);
      assert.notInclude(`${error} ${JSON.stringify(error)}`, "secret");
    }));
});
