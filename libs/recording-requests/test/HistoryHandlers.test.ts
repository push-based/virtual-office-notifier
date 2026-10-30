import { DiscordOAuth } from "activity-sign-in/DiscordOAuth";
import { Sessions } from "activity-sign-in/Sessions";
import { SignedInSession } from "activity-sign-in/SignInApi";
import { SignInSettings } from "activity-sign-in/SignInSettings";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, pipe, Redacted, Ref, Schema, String } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { OfficeStatsReader } from "../src/OfficeStats.ts";
import type { ListedRecording, RecordingDetail } from "../src/Recording.ts";
import type { RecordingChange } from "../src/RecordingEdit.ts";
import { RecordingApi } from "../src/RecordingApi.ts";
import { EditHandlers, HistoryHandlers, RecordingHandlers } from "../src/RecordingHandlers.ts";
import { RecordingEdits } from "../src/RecordingEdits.ts";
import { RecordingHistory } from "../src/RecordingHistory.ts";
import { RecordingRequests } from "../src/RecordingRequests.ts";
import { SignedInLayer, SignInHandlers } from "../src/SignInHandlers.ts";
import { StatsHandlers } from "../src/StatsHandlers.ts";
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
  title: "Deploy retro",
};

const detail: RecordingDetail = {
  ...listed,
  agenda: "What broke on Friday",
  stopReason: "requested",
  stoppedBy: ada,
  summary: "• Ada said hello",
  summaryModel: "model",
  slackPermalink: "https://office.slack.com/archives/C1/p12",
  clips: [{ speaker: ada, startedAt: DateTime.makeUnsafe("2026-10-29T12:06:00Z"), text: "Hello" }],
  actionItems: [
    { id: 4, text: "write up the deploy checklist", owner: ada, done: true },
    { id: 5, text: "ask IT about the VPN", owner: null, done: false },
  ],
  members: [ada],
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

const submittedEdits = Ref.makeUnsafe<ReadonlyArray<RecordingChange>>([]);

const Edits = Layer.succeed(
  RecordingEdits,
  RecordingEdits.of({
    submit: (_editor, recordingId, change) =>
      recordingId === RECORDING
        ? Ref.update(submittedEdits, (all) => [...all, change]).pipe(
            Effect.as(Option.some({ id: 7, outcome: null })),
          )
        : Effect.succeedNone,
    find: (_editor, id) =>
      Effect.succeed(id === 7 ? Option.some({ id, outcome: "applied" as const }) : Option.none()),
    handlePending: () => Effect.void,
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
      StatsHandlers.pipe(Layer.provide(OfficeStatsReader.layerDisabled)),
      EditHandlers.pipe(Layer.provide(Edits)),
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

  return (path: string, init: RequestInit = {}) =>
    send(path, {
      ...init,
      headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    });
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
            title: "Deploy retro",
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
        title: "Deploy retro",
        agenda: "What broke on Friday",
        stopReason: "requested",
        slackPermalink: "https://office.slack.com/archives/C1/p12",
        clips: [{ speaker: ada, startedAt: "2026-10-29T12:06:00.000Z", text: "Hello" }],
        actionItems: [
          { id: 4, text: "write up the deploy checklist", owner: ada, done: true },
          { id: 5, text: "ask IT about the VPN", owner: null, done: false },
        ],
        members: [ada],
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

const xs = (count: number) => pipe("x", String.repeat(count));

describe("the recording edits API", () => {
  it.effect("takes an edit of a recording, tidied up, and answers 202 with it pending", () =>
    Effect.gen(function* () {
      const call = yield* signedIn;
      yield* Ref.set(submittedEdits, []);

      const response = yield* call(`/api/recordings/${RECORDING}/edits`, {
        method: "POST",
        body: '{"kind":"title","title":"  Deploy   retro "}',
      });

      assert.strictEqual(response.status, 202);
      assert.deepStrictEqual(yield* decodeJson(yield* bodyOf(response)), { id: 7, outcome: null });
      assert.deepStrictEqual(yield* Ref.get(submittedEdits), [
        { kind: "title", title: "Deploy retro" },
      ]);
    }),
  );

  it.effect("clears a title or agenda when it's blank", () =>
    Effect.gen(function* () {
      const call = yield* signedIn;
      yield* Ref.set(submittedEdits, []);

      yield* call(`/api/recordings/${RECORDING}/edits`, {
        method: "POST",
        body: '{"kind":"agenda","agenda":"   "}',
      });
      yield* call(`/api/recordings/${RECORDING}/edits`, {
        method: "POST",
        body: '{"kind":"title","title":null}',
      });

      assert.deepStrictEqual(yield* Ref.get(submittedEdits), [
        { kind: "agenda", agenda: null },
        { kind: "title", title: null },
      ]);
    }),
  );

  it.effect(
    "refuses a title over 80 characters, an agenda over 500, and a kind it doesn't know",
    () =>
      Effect.gen(function* () {
        const call = yield* signedIn;

        const post = (body: string) =>
          call(`/api/recordings/${RECORDING}/edits`, { method: "POST", body });

        assert.strictEqual((yield* post(`{"kind":"title","title":"${xs(81)}"}`)).status, 400);
        assert.strictEqual((yield* post(`{"kind":"title","title":"${xs(80)}"}`)).status, 202);
        assert.strictEqual((yield* post(`{"kind":"agenda","agenda":"${xs(501)}"}`)).status, 400);
        assert.strictEqual((yield* post(`{"kind":"summary_style","style":"brief"}`)).status, 400);
      }),
  );

  it.effect("takes ticks, unticks and reassigns of an action item", () =>
    Effect.gen(function* () {
      const call = yield* signedIn;
      yield* Ref.set(submittedEdits, []);

      const post = (body: string) =>
        call(`/api/recordings/${RECORDING}/edits`, { method: "POST", body });

      assert.strictEqual((yield* post('{"kind":"tick","item":4}')).status, 202);
      assert.strictEqual((yield* post('{"kind":"untick","item":4}')).status, 202);
      assert.strictEqual((yield* post('{"kind":"reassign","item":5,"owner":"u1"}')).status, 202);
      assert.strictEqual((yield* post('{"kind":"reassign","item":5,"owner":null}')).status, 202);
      assert.strictEqual((yield* post('{"kind":"reword","item":5,"text":"x"}')).status, 400);

      assert.deepStrictEqual(yield* Ref.get(submittedEdits), [
        { kind: "tick", item: 4 },
        { kind: "untick", item: 4 },
        { kind: "reassign", item: 5, owner: "u1" },
        { kind: "reassign", item: 5, owner: null },
      ]);
    }),
  );

  it.effect("checks on an edit, and answers 404 for an edit or recording that doesn't exist", () =>
    Effect.gen(function* () {
      const call = yield* signedIn;

      const found = yield* call("/api/edits/7");
      assert.strictEqual(found.status, 200);
      assert.deepStrictEqual(yield* decodeJson(yield* bodyOf(found)), {
        id: 7,
        outcome: "applied",
      });

      assert.strictEqual((yield* call("/api/edits/8")).status, 404);
      assert.strictEqual(
        (yield* call("/api/recordings/8c3d4e5f-1111-4c55-9a0e-8e3b8f9b2a10/edits", {
          method: "POST",
          body: '{"kind":"title","title":"Retro"}',
        })).status,
        404,
      );
    }),
  );

  it.effect("turns away anyone who isn't signed in", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* send(`/api/recordings/${RECORDING}/edits`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"kind":"title","title":"Retro"}',
        })).status,
        401,
      );
      assert.strictEqual((yield* send("/api/edits/7")).status, 401);
    }),
  );
});
