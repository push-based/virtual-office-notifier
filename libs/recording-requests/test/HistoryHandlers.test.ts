import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignedInSession } from "activity-sign-in/SignInApi";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import type { ListedRecording, RecordingDetail } from "../src/Recording.ts";
import { RecordingApi } from "../src/RecordingApi.ts";
import { HistoryHandlers, RecordingHandlers } from "../src/RecordingHandlers.ts";
import { RecordingHistory } from "../src/RecordingHistory.ts";
import { RecordingRequests } from "../src/RecordingRequests.ts";
import { SignedInLayer, SignInHandlers } from "../src/SignInHandlers.ts";
import type * as Wire from "../src/Wire.ts";

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const ada = { userId: "u1", name: "Ada", avatarUrl: null };

const listed: ListedRecording = {
  id: RECORDING,
  state: "finished",
  startedAt: DateTime.makeUnsafe("2026-10-29T12:05:00Z"),
  stoppedAt: DateTime.makeUnsafe("2026-10-29T13:17:00Z"),
  startedBy: ada,
  speakers: [ada],
};

const detail: RecordingDetail = {
  ...listed,
  stopReason: "requested",
  stoppedBy: ada,
  summary: "• Ada said hello",
  summaryModel: "model",
  slackPermalink: "https://office.slack.com/archives/C1/p12",
  clips: [{ speaker: ada, startedAt: DateTime.makeUnsafe("2026-10-29T12:06:00Z"), text: "Hello" }],
};

const asked = Ref.makeUnsafe<ReadonlyArray<Option.Option<DateTime.Utc>>>([]);

const History = Layer.succeed(
  RecordingHistory,
  RecordingHistory.of({
    page: (before) =>
      Ref.update(asked, (all) => [...all, before]).pipe(
        Effect.as({ recordings: [listed], older: listed.startedAt }),
      ),
    find: (id) => Effect.succeed(id === RECORDING ? Option.some(detail) : Option.none()),
  }),
);

const Discord = Layer.succeed(
  DiscordOAuth,
  DiscordOAuth.of({
    exchange: () =>
      Effect.succeed({ accessToken: "t0k3n", user: { id: "u1", name: "Ada", avatarUrl: null } }),
  }),
);

const Settings = Layer.succeed(
  SignInSettings,
  SignInSettings.of({
    clientId: "client-id",
    clientSecret: Redacted.make("client-secret"),
    sessionSecret: Redacted.make("session-secret"),
  }),
);

const app = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(RecordingApi).pipe(
    Layer.provide([
      SignInHandlers.pipe(Layer.provide(Discord)),
      RecordingHandlers.pipe(Layer.provide(RecordingRequests.layerDisabled)),
      HistoryHandlers.pipe(Layer.provide(History)),
    ]),
    Layer.provideMerge(SignedInLayer),
    Layer.provide(Sessions.layer),
    Layer.provide(Settings),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

afterAll(() => app.dispose());

const send = (path: string, init?: RequestInit) =>
  Effect.promise(() => app.handler(new Request(`http://recorder.test${path}`, init)));

const bodyOf = (response: Response) => Effect.promise(() => response.text());

const decodeSignedIn = Schema.decodeEffect(Schema.fromJsonString(SignedInSession));

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const signedIn = Effect.gen(function* () {
  const response = yield* send("/api/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"code":"good-code"}',
  });

  const { session } = yield* decodeSignedIn(yield* bodyOf(response));

  return (path: string) => send(path, { headers: { authorization: `Bearer ${session}` } });
});

describe("the recording history API", () => {
  it.effect("lists recordings for anyone signed in, with times as ISO strings", () =>
    Effect.gen(function* () {
      const get = yield* signedIn;
      const response = yield* get("/api/recordings");

      assert.strictEqual(response.status, 200);

      const page = yield* decodeJson(yield* bodyOf(response));

      const expected: Wire.RecordingPage = {
        recordings: [
          {
            id: RECORDING,
            state: "finished",
            startedAt: "2026-10-29T12:05:00.000Z",
            stoppedAt: "2026-10-29T13:17:00.000Z",
            startedBy: ada,
            speakers: [ada],
          },
        ],
        older: "2026-10-29T12:05:00.000Z",
      };

      assert.deepStrictEqual(page, expected);
    }),
  );

  it.effect("passes Show older's start time on to the history", () =>
    Effect.gen(function* () {
      const get = yield* signedIn;
      yield* Ref.set(asked, []);

      yield* get("/api/recordings");
      yield* get("/api/recordings?before=2026-10-29T12:05:00.000Z");

      assert.deepStrictEqual(yield* Ref.get(asked), [
        Option.none(),
        Option.some(DateTime.makeUnsafe("2026-10-29T12:05:00Z")),
      ]);
    }),
  );

  it.effect("gives one recording with its clips", () =>
    Effect.gen(function* () {
      const get = yield* signedIn;
      const response = yield* get(`/api/recordings/${RECORDING}`);

      assert.strictEqual(response.status, 200);

      const body = yield* decodeJson(yield* bodyOf(response));

      assert.deepInclude(body, {
        stopReason: "requested",
        slackPermalink: "https://office.slack.com/archives/C1/p12",
        clips: [{ speaker: ada, startedAt: "2026-10-29T12:06:00.000Z", text: "Hello" }],
      });
    }),
  );

  it.effect("answers 404 for a recording that doesn't exist and 400 for one that can't", () =>
    Effect.gen(function* () {
      const get = yield* signedIn;

      assert.strictEqual(
        (yield* get("/api/recordings/8c3d4e5f-1111-4c55-9a0e-8e3b8f9b2a10")).status,
        404,
      );
      assert.strictEqual((yield* get("/api/recordings/not-a-recording")).status, 400);
      assert.strictEqual((yield* get("/api/recordings?before=yesterday")).status, 400);
    }),
  );

  it.effect("turns away anyone who isn't signed in", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* send("/api/recordings")).status, 401);
      assert.strictEqual((yield* send(`/api/recordings/${RECORDING}`)).status, 401);
    }),
  );
});
