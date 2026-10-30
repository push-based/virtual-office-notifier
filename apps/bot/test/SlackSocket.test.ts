import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Layer, Option, pipe, Queue, Schema, Stream, String } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import { SlackClient } from "../src/SlackClient.ts";
import type { Envelope } from "../src/SlackEvent.ts";
import { SlackSocket } from "../src/SlackSocket.ts";
import { makeFakeSlackHttp, type Reply, SLACK_ENV, slackError, slackOk, withEnv } from "./fakes.ts";

type Listener = (event: Socket.WebSocketEvent) => void;

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

class FakeWebSocket implements Socket.WebSocketLike {
  readyState = 1;

  readonly sent: Array<string> = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener, options?: { readonly once?: boolean }): void {
    const wrapped: Listener =
      options?.once === true
        ? (event) => {
            this.removeEventListener(type, wrapped);
            listener(event);
          }
        : listener;

    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), wrapped]));
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    this.sent.push(globalThis.String(data));
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;

    this.readyState = 3;
    this.emit("close", { type: "close", code });
  }

  receive(
    message: Record<string, string | number | Record<string, string | Record<string, string>>>,
  ): void {
    this.emit("message", { type: "message", data: JSON.stringify(message) });
  }

  private emit(type: string, event: Socket.WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const threadReply = {
  type: "message",
  channel: "C-OFFICE",
  user: "U1",
  text: "Sam is a machine",
  ts: "2.0",
  thread_ts: "1.0",
  parent_user_id: "UBOT",
};

const eventEnvelope = (envelopeId: string, retryAttempt = 0) => ({
  envelope_id: envelopeId,
  type: "events_api",
  retry_attempt: retryAttempt,
  payload: { type: "event_callback", event: threadReply },
});

const connection = (ticket: string) =>
  slackOk({ url: `wss://wss-primary.slack.com/link/?ticket=${ticket}` });

const settle = TestClock.adjust("1 millis");

const connect = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const sockets: Array<FakeWebSocket> = [];
  const http = yield* makeFakeSlackHttp(replies);
  const received = yield* Queue.unbounded<Envelope>();

  const layer = SlackSocket.layerNoDeps.pipe(
    Layer.provide(SlackClient.layerNoDeps.pipe(Layer.provide(http.layer))),
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor, (url) => {
        const socket = new FakeWebSocket(url);

        sockets.push(socket);

        return socket;
      }),
    ),
  );

  const slackSocket = yield* Effect.service(SlackSocket).pipe(
    Effect.provide(layer),
    withEnv(SLACK_ENV),
  );

  yield* Stream.runForEach(slackSocket.envelopes, (envelope) =>
    Queue.offer(received, envelope),
  ).pipe(Effect.forkChild);
  yield* settle;

  return {
    sockets,
    latest: () => sockets.at(-1)!,
    received: Queue.clear(received),
    connectionsOpened: http.requests.pipe(
      Effect.map(
        (sent) =>
          Array.filter(sent, (request) =>
            pipe(request.url, String.endsWith("apps.connections.open")),
          ).length,
      ),
    ),
  };
});

describe("SlackSocket", () => {
  it.effect("connects to the URL Slack hands out", () =>
    Effect.gen(function* () {
      const slack = yield* connect([connection("first")]);

      assert.strictEqual(slack.latest().url, "wss://wss-primary.slack.com/link/?ticket=first");
    }),
  );

  it.effect("acks an event before handing it on", () =>
    Effect.gen(function* () {
      const slack = yield* connect([connection("first")]);
      const socket = slack.latest();

      socket.receive({ type: "hello" });
      socket.receive(eventEnvelope("env-1"));
      yield* settle;

      assert.deepStrictEqual(yield* Effect.forEach(socket.sent, (sent) => decodeJson(sent)), [
        { envelope_id: "env-1" },
      ]);

      const [envelope] = yield* slack.received;
      assert.deepStrictEqual(envelope?.envelopeId, Option.some("env-1"));
      assert.isTrue(Option.isSome(envelope!.event));
    }),
  );

  it.effect("acks a redelivery but drops it", () =>
    Effect.gen(function* () {
      const slack = yield* connect([connection("first")]);
      const socket = slack.latest();

      socket.receive(eventEnvelope("env-1", 1));
      yield* settle;

      assert.deepStrictEqual(yield* Effect.forEach(socket.sent, (sent) => decodeJson(sent)), [
        { envelope_id: "env-1" },
      ]);
      assert.deepStrictEqual(yield* slack.received, []);
    }),
  );

  it.effect("reconnects straight away with a fresh URL when Slack asks it to", () =>
    Effect.gen(function* () {
      const slack = yield* connect([connection("first"), connection("second")]);

      slack.latest().receive({ type: "disconnect", reason: "refresh_requested" });
      yield* settle;

      assert.strictEqual(yield* slack.connectionsOpened, 2);
      assert.strictEqual(slack.latest().url, "wss://wss-primary.slack.com/link/?ticket=second");

      slack.latest().receive(eventEnvelope("env-2"));
      yield* settle;

      assert.strictEqual((yield* slack.received).length, 1);
    }),
  );

  it.effect("reconnects with backoff when the connection drops", () =>
    Effect.gen(function* () {
      const slack = yield* connect([connection("first"), connection("second")]);

      slack.latest().close(1006);
      yield* settle;

      assert.strictEqual(slack.sockets.length, 1);

      yield* TestClock.adjust("2 seconds");

      assert.strictEqual(slack.sockets.length, 2);
    }),
  );

  it.effect("keeps trying when Slack won't open a connection, without failing", () =>
    Effect.gen(function* () {
      const slack = yield* connect([
        slackError("invalid_auth"),
        slackError("invalid_auth"),
        connection("finally"),
      ]);

      assert.strictEqual(slack.sockets.length, 0);

      yield* TestClock.adjust("1 minute");

      assert.strictEqual(slack.sockets.length, 1);
      assert.strictEqual(slack.latest().url, "wss://wss-primary.slack.com/link/?ticket=finally");
    }),
  );
});
