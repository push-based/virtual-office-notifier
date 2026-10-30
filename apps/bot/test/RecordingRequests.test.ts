import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest, HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { SqlClient } from "effect/sql";
import {
  CurrentRequester,
  RecordingApi,
  SignedIn,
  Unauthorized,
} from "recording-requests/RecordingApi";
import { RecordingHandlers } from "recording-requests/RecordingHandlers";
import type { ActiveRecording } from "recording-requests/RecordingRequest";
import { RecordingRequests, type RequestHandler } from "recording-requests/RecordingRequests";

import { columnNaming, Database } from "../src/Database.ts";
import { RecordingStore, StoreUnavailable } from "../src/RecordingStore.ts";

const ada = { id: "u1", name: "Ada" };

const grace = { id: "u2", name: "Grace" };

const TestLayer = Layer.mergeAll(
  Layer.effect(
    RecordingRequests,
    Effect.gen(function* () {
      const database = yield* Database;

      return yield* RecordingRequests.make(database.ready);
    }),
  ),
  RecordingStore.layer,
).pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const recordingBy = (startedBy: string): ActiveRecording => ({
  id: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
  startedAt: DateTime.makeUnsafe(0),
  startedBy,
  pause: Option.none(),
});

interface Office {
  readonly occupants: ReadonlyArray<string>;
  readonly active?: ActiveRecording;
  readonly failStartAfterWriting?: boolean;
}

const officeHandler = Effect.fnUntraced(function* (office: Office) {
  const store = yield* RecordingStore;
  const committed: Array<string> = [];

  const handler: RequestHandler<StoreUnavailable, never> = {
    situation: Effect.succeed({
      occupants: new Set(office.occupants),
      active: Option.fromUndefinedOr(office.active),
    }),
    start: (request) =>
      Effect.gen(function* () {
        const recording = recordingBy(request.requestedBy);

        yield* store.startRecording({
          ...recording,
          guildId: "guild",
          channelId: "office",
          startedByName: request.requestedByName,
        });

        if (office.failStartAfterWriting === true)
          return yield* StoreUnavailable.make({ reason: "Lost the connection" });

        return {
          recordingId: recording.id,
          afterCommit: Effect.sync(() => committed.push(`started ${recording.id}`)),
        };
      }),
    stop: (request, recording) =>
      store
        .stopRecording(recording.id, DateTime.makeUnsafe(60_000), "requested", request.requestedBy)
        .pipe(
          Effect.as({
            recordingId: recording.id,
            afterCommit: Effect.sync(() => committed.push(`stopped ${recording.id}`)),
          }),
        ),
    pause: (request, recording) =>
      store
        .pauseRecording(
          recording.id,
          DateTime.makeUnsafe(30_000),
          request.requestedBy,
          request.requestedByName,
        )
        .pipe(
          Effect.as({
            recordingId: recording.id,
            afterCommit: Effect.sync(() => committed.push(`paused ${recording.id}`)),
          }),
        ),
    resume: (request, recording) =>
      store
        .resumeRecording(
          recording.id,
          DateTime.makeUnsafe(45_000),
          request.requestedBy,
          request.requestedByName,
        )
        .pipe(
          Effect.as({
            recordingId: recording.id,
            afterCommit: Effect.sync(() => committed.push(`resumed ${recording.id}`)),
          }),
        ),
  };

  return { handler, committed };
});

describe("RecordingRequests", () => {
  it.effect("shows a submitted request as pending, only to whoever submitted it", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;

      const submitted = yield* requests.submit(ada, "start");
      assert.deepStrictEqual(submitted, { id: submitted.id, outcome: null });

      assert.deepStrictEqual(yield* requests.find(ada, submitted.id), Option.some(submitted));
      assert.deepStrictEqual(yield* requests.find(grace, submitted.id), Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("starts a recording for someone in the office and says so once it's committed", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const { handler, committed } = yield* officeHandler({ occupants: ["u1"] });

      const submitted = yield* requests.submit(ada, "start");
      yield* requests.handlePending(handler);

      assert.deepStrictEqual(
        yield* requests.find(ada, submitted.id),
        Option.some({ id: submitted.id, outcome: "started" as const }),
      );
      assert.deepStrictEqual(committed, ["started 6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stops the running recording", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const starting = yield* officeHandler({ occupants: ["u1", "u2"] });

      yield* requests.submit(ada, "start");
      yield* requests.handlePending(starting.handler);

      const stopping = yield* officeHandler({ occupants: ["u1", "u2"], active: recordingBy("u1") });
      const submitted = yield* requests.submit(grace, "stop");
      yield* requests.handlePending(stopping.handler);

      assert.deepStrictEqual(
        yield* requests.find(grace, submitted.id),
        Option.some({ id: submitted.id, outcome: "stopped" as const }),
      );
      assert.deepStrictEqual(stopping.committed, ["stopped 6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pauses and resumes the running recording for anyone in the office", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const starting = yield* officeHandler({ occupants: ["u1", "u2"] });

      yield* requests.submit(ada, "start");
      yield* requests.handlePending(starting.handler);

      const pausing = yield* officeHandler({ occupants: ["u1", "u2"], active: recordingBy("u1") });
      const pause = yield* requests.submit(grace, "pause");
      yield* requests.handlePending(pausing.handler);

      assert.deepStrictEqual(
        yield* requests.find(grace, pause.id),
        Option.some({ id: pause.id, outcome: "paused" as const }),
      );
      assert.deepStrictEqual(pausing.committed, ["paused 6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10"]);

      const resuming = yield* officeHandler({
        occupants: ["u1", "u2"],
        active: {
          ...recordingBy("u1"),
          pause: Option.some({ pausedAt: DateTime.makeUnsafe(30_000), pausedBy: "u2" }),
        },
      });

      const resume = yield* requests.submit(ada, "resume");
      yield* requests.handlePending(resuming.handler);

      assert.deepStrictEqual(
        yield* requests.find(ada, resume.id),
        Option.some({ id: resume.id, outcome: "resumed" as const }),
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores a second pause and a resume of a running recording, and says why", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;

      const running = yield* officeHandler({ occupants: ["u1"], active: recordingBy("u1") });
      const resume = yield* requests.submit(ada, "resume");
      yield* requests.handlePending(running.handler);

      const paused = yield* officeHandler({
        occupants: ["u1"],
        active: {
          ...recordingBy("u1"),
          pause: Option.some({ pausedAt: DateTime.makeUnsafe(30_000), pausedBy: "u1" }),
        },
      });

      const pause = yield* requests.submit(ada, "pause");
      yield* requests.handlePending(paused.handler);

      assert.deepStrictEqual(
        yield* requests.find(ada, resume.id),
        Option.some({
          id: resume.id,
          outcome: "ignored" as const,
          reason: "not_paused" as const,
          explanation: "The recording isn't paused.",
        }),
      );
      assert.deepStrictEqual(
        yield* requests.find(ada, pause.id),
        Option.some({
          id: pause.id,
          outcome: "ignored" as const,
          reason: "already_paused" as const,
          explanation: "Someone already paused the recording.",
        }),
      );
      assert.deepStrictEqual([...running.committed, ...paused.committed], []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores a request with the reason and an explanation", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const { handler, committed } = yield* officeHandler({ occupants: ["u2"] });

      const submitted = yield* requests.submit(ada, "start");
      yield* requests.handlePending(handler);

      const found = yield* requests.find(ada, submitted.id);
      assert.deepStrictEqual(
        found,
        Option.some({
          id: submitted.id,
          outcome: "ignored" as const,
          reason: "not_in_office" as const,
          explanation: "You need to be in the office voice channel to do that.",
        }),
      );
      assert.deepStrictEqual(committed, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "leaves the request pending and writes nothing when starting fails, so the retry starts it",
    () =>
      Effect.gen(function* () {
        const requests = yield* RecordingRequests;
        const sql = yield* SqlClient.SqlClient;
        const failing = yield* officeHandler({ occupants: ["u1"], failStartAfterWriting: true });

        const submitted = yield* requests.submit(ada, "start");
        const error = yield* requests.handlePending(failing.handler).pipe(Effect.flip);
        assert.strictEqual(error._tag, "StoreUnavailable");

        assert.deepStrictEqual(
          yield* requests.find(ada, submitted.id),
          Option.some({ id: submitted.id, outcome: null }),
        );
        assert.deepStrictEqual(yield* sql`SELECT id FROM office.recordings`, []);
        assert.deepStrictEqual(failing.committed, []);

        const working = yield* officeHandler({ occupants: ["u1"] });
        yield* requests.handlePending(working.handler);

        assert.deepStrictEqual(
          yield* requests.find(ada, submitted.id),
          Option.some({ id: submitted.id, outcome: "started" as const }),
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("expires a request by the database's clock", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const sql = yield* SqlClient.SqlClient;
      const { handler } = yield* officeHandler({ occupants: ["u1"] });

      const submitted = yield* requests.submit(ada, "start");
      yield* sql`UPDATE office.recording_requests SET requested_at = now() - interval '2 minutes' WHERE id = ${submitted.id}`;
      yield* requests.handlePending(handler);

      const found = yield* requests.find(ada, submitted.id);
      assert.strictEqual(Option.getOrUndefined(found)?.outcome, "ignored");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("publishes the recording status with who started the recording and when it ends", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const { handler } = yield* officeHandler({ occupants: ["u1"] });

      yield* requests.submit(ada, "start");
      yield* requests.handlePending(handler);
      yield* requests.publishStatus({
        recordingId: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
        botInOffice: true,
        occupants: [{ userId: "u1", displayName: "Ada", avatarUrl: null }],
      });

      const status = yield* requests.status;
      assert.isTrue(status.botInOffice);
      assert.deepStrictEqual(status.occupants, [
        { userId: "u1", displayName: "Ada", avatarUrl: null },
      ]);
      assert.strictEqual(status.recording?.startedByName, "Ada");
      assert.strictEqual(
        status.recording && DateTime.formatIso(status.recording.endsAt),
        "1970-01-01T04:00:00.000Z",
      );

      assert.isNull(status.recording?.pause);

      const store = yield* RecordingStore;
      yield* store.pauseRecording(
        "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
        DateTime.makeUnsafe(60_000),
        "u2",
        "Grace",
      );

      const paused = yield* requests.status;
      assert.strictEqual(paused.recording?.pause?.byName, "Grace");
      assert.strictEqual(
        paused.recording?.pause && DateTime.formatIso(paused.recording.pause.since),
        "1970-01-01T00:01:00.000Z",
      );

      yield* requests.publishStatus({ recordingId: null, botInOffice: false, occupants: [] });

      const after = yield* requests.status;
      assert.isNull(after.recording);
      assert.isFalse(after.botInOffice);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("records nothing and says so when there's no database", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;

      const error = yield* requests.status.pipe(Effect.flip);
      assert.strictEqual(error.reason, "Nothing is recorded");

      yield* requests.publishStatus({ recordingId: null, botInOffice: false, occupants: [] });
    }).pipe(Effect.provide(RecordingRequests.layerDisabled)),
  );
});

const SignedInTest = Layer.succeed(
  SignedIn,
  SignedIn.of({
    session: (httpEffect, { credential }) =>
      Redacted.value(credential) === "ada-session"
        ? Effect.provideService(httpEffect, CurrentRequester, ada)
        : Effect.fail(Unauthorized.make()),
  }),
);

const withSession = (session: string) =>
  HttpApiMiddleware.layerClient(SignedIn, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, session)),
  );

const HttpLayer = Layer.mergeAll(
  RecordingHandlers.pipe(Layer.provide(TestLayer), Layer.provideMerge(SignedInTest)),
  HttpServer.layerServices,
);

describe("the Office Recorder's HTTP API", () => {
  it.effect("submits a request and looks it up for the signed-in person", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(RecordingApi, ["recording"]);

      const submitted = yield* client.recording.submit({ payload: { action: "start" } });
      assert.strictEqual(submitted.outcome, null);

      const found = yield* client.recording.find({ params: { id: submitted.id } });
      assert.deepStrictEqual(found, submitted);

      const missing = yield* client.recording
        .find({ params: { id: submitted.id + 1 } })
        .pipe(Effect.flip);

      assert.strictEqual(missing._tag, "RequestNotFound");
    }).pipe(Effect.provide(Layer.mergeAll(withSession("ada-session"), HttpLayer))),
  );

  it.effect("sends the recording status with times as ISO strings", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(RecordingApi, ["recording"]);

      const status = yield* client.recording.status();
      assert.isFalse(status.botInOffice);
      assert.isTrue(Schema.is(Schema.DateTimeUtc)(status.updatedAt));
    }).pipe(Effect.provide(Layer.mergeAll(withSession("ada-session"), HttpLayer))),
  );

  it.effect("turns away anyone without a valid session", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(RecordingApi, ["recording"]);

      const error = yield* client.recording.status().pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(Layer.mergeAll(withSession("someone-else"), HttpLayer))),
  );
});
