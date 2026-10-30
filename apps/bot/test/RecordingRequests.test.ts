import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, pipe, Redacted, Schema, String } from "effect";
import { HttpClientRequest, HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { SqlClient } from "effect/sql";
import {
  CurrentRequester,
  RecordingApi,
  SignedIn,
  Unauthorized,
} from "recording-requests/RecordingApi";
import { EditHandlers, RecordingHandlers } from "recording-requests/RecordingHandlers";
import { type EditHandler, RecordingEdits } from "recording-requests/RecordingEdits";
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
  Layer.effect(
    RecordingEdits,
    Effect.gen(function* () {
      const database = yield* Database;

      return yield* RecordingEdits.make(database.ready);
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
          title: request.title,
          agenda: request.agenda,
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

  it.effect(
    "starts the recording with the title and agenda of the Start request, and keeps them off any other request",
    () =>
      Effect.gen(function* () {
        const requests = yield* RecordingRequests;
        const sql = yield* SqlClient.SqlClient;
        const { handler } = yield* officeHandler({ occupants: ["u1"] });
        const plan = { title: "Deploy retro", agenda: "What broke on Friday" };

        yield* requests.submit(ada, "start", plan);
        yield* requests.submit(ada, "stop", plan);
        yield* requests.handlePending(handler);

        assert.deepStrictEqual(
          yield* sql`SELECT action, title, agenda FROM office.recording_requests ORDER BY id`,
          [
            { action: "start", ...plan },
            { action: "stop", title: null, agenda: null },
          ],
        );
        assert.deepStrictEqual(yield* sql`SELECT title, agenda FROM office.recordings`, [plan]);

        yield* requests.publishStatus({
          recordingId: "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10",
          botInOffice: true,
          occupants: [],
        });

        const status = yield* requests.status;
        assert.strictEqual(status.recording?.title, "Deploy retro");
        assert.strictEqual(status.recording?.agenda, "What broke on Friday");
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
        occupants: [{ userId: "u1", displayName: "Ada", avatarUrl: null, speaking: true }],
      });

      const status = yield* requests.status;
      assert.isTrue(status.botInOffice);
      assert.deepStrictEqual(status.occupants, [
        { userId: "u1", displayName: "Ada", avatarUrl: null, speaking: true },
      ]);
      assert.strictEqual(status.recording?.startedByName, "Ada");
      assert.strictEqual(
        status.recording && DateTime.formatIso(status.recording.endsAt),
        "1970-01-01T04:00:00.000Z",
      );

      assert.isNull(status.recording?.pause);
      assert.isNull(status.recording?.title);
      assert.isNull(status.recording?.agenda);

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

  it.effect("reads occupants written before speaking was tracked as not speaking", () =>
    Effect.gen(function* () {
      const requests = yield* RecordingRequests;
      const sql = yield* SqlClient.SqlClient;

      yield* requests.publishStatus({ recordingId: null, botInOffice: true, occupants: [] });
      yield* sql`UPDATE office.recording_status SET occupants = '[{"userId":"u1","displayName":"Ada","avatarUrl":null}]'::jsonb`;

      assert.deepStrictEqual((yield* requests.status).occupants, [
        { userId: "u1", displayName: "Ada", avatarUrl: null, speaking: false },
      ]);
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

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const recorded = (finished: { readonly posted: boolean } | null) =>
  Effect.gen(function* () {
    const store = yield* RecordingStore;

    yield* store.startRecording({
      id: RECORDING,
      guildId: "guild",
      channelId: "office",
      startedAt: DateTime.makeUnsafe(0),
      startedBy: "u1",
      startedByName: "Ada",
      title: null,
      agenda: null,
    });

    if (finished === null) return;

    yield* store.stopRecording(RECORDING, DateTime.makeUnsafe(60_000), "requested", "u1");
    yield* store.finishRecording(RECORDING, {
      transcript: "",
      summary: null,
      summaryModel: null,
      slackChannelId: finished.posted ? "C1" : null,
      slackTs: finished.posted ? "1.2" : null,
      slackPermalink: null,
      finishedAt: DateTime.makeUnsafe(61_000),
    });
  });

const editHandler = Effect.fnUntraced(function* (failAfterWriting: boolean) {
  const store = yield* RecordingStore;
  const committed: Array<string> = [];

  const handler: EditHandler<StoreUnavailable, never> = {
    apply: (edit) =>
      Effect.gen(function* () {
        yield* store.applyEdit(edit.recordingId, edit.change);

        if (failAfterWriting)
          return yield* StoreUnavailable.make({ reason: "Lost the connection" });

        return {
          afterCommit: Effect.sync(() => committed.push(`${edit.change.kind} by ${edit.editedBy}`)),
        };
      }),
  };

  return { handler, committed };
});

const titleOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly title: string | null }>`SELECT title FROM office.recordings`;

  return row?.title ?? null;
});

describe("RecordingEdits", () => {
  it.effect(
    "shows a submitted edit as pending, only to whoever made it, and refuses a recording that doesn't exist",
    () =>
      Effect.gen(function* () {
        const edits = yield* RecordingEdits;

        yield* recorded(null);

        const submitted = yield* edits.submit(grace, RECORDING, { kind: "title", title: "Retro" });
        const id = Option.getOrThrow(submitted).id;
        assert.deepStrictEqual(submitted, Option.some({ id, outcome: null }));

        assert.deepStrictEqual(yield* edits.find(grace, id), submitted);
        assert.deepStrictEqual(yield* edits.find(ada, id), Option.none());

        assert.deepStrictEqual(
          yield* edits.submit(grace, "8c3d4e5f-1111-4c55-9a0e-8e3b8f9b2a10", {
            kind: "title",
            title: "Retro",
          }),
          Option.none(),
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("applies edits in order once each is committed, and keeps who made each one", () =>
    Effect.gen(function* () {
      const edits = yield* RecordingEdits;
      const sql = yield* SqlClient.SqlClient;
      const { handler, committed } = yield* editHandler(false);

      yield* recorded({ posted: true });

      const first = yield* edits.submit(grace, RECORDING, { kind: "title", title: "Retro" });
      yield* edits.submit(ada, RECORDING, { kind: "agenda", agenda: "Friday" });
      yield* edits.submit(ada, RECORDING, { kind: "title", title: null });
      yield* edits.handlePending(handler);

      const id = Option.getOrThrow(first).id;
      assert.deepStrictEqual(
        yield* edits.find(grace, id),
        Option.some({ id, outcome: "applied" as const }),
      );
      assert.deepStrictEqual(committed, ["title by u2", "agenda by u1", "title by u1"]);
      assert.isNull(yield* titleOf);

      const rows = yield* sql`
        SELECT edited_by, edited_by_name, change, handled_at >= edited_at AS handled_after
        FROM office.recording_edits ORDER BY id
      `;

      assert.deepStrictEqual(rows, [
        {
          editedBy: "u2",
          editedByName: "Grace",
          change: { kind: "title", title: "Retro" },
          handledAfter: true,
        },
        {
          editedBy: "u1",
          editedByName: "Ada",
          change: { kind: "agenda", agenda: "Friday" },
          handledAfter: true,
        },
        {
          editedBy: "u1",
          editedByName: "Ada",
          change: { kind: "title", title: null },
          handledAfter: true,
        },
      ]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores an edit of a silent recording, and says why", () =>
    Effect.gen(function* () {
      const edits = yield* RecordingEdits;
      const { handler, committed } = yield* editHandler(false);

      yield* recorded({ posted: false });

      const submitted = yield* edits.submit(ada, RECORDING, { kind: "title", title: "Lunch" });
      yield* edits.handlePending(handler);

      const id = Option.getOrThrow(submitted).id;

      assert.deepStrictEqual(
        yield* edits.find(ada, id),
        Option.some({
          id,
          outcome: "ignored" as const,
          reason: "silent" as const,
          explanation: "Nobody spoke in that recording, so there's nothing to change.",
        }),
      );
      assert.deepStrictEqual(committed, []);
      assert.isNull(yield* titleOf);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("ignores an edit it can't read instead of getting stuck on it", () =>
    Effect.gen(function* () {
      const edits = yield* RecordingEdits;
      const sql = yield* SqlClient.SqlClient;
      const { handler } = yield* editHandler(false);

      yield* recorded(null);
      yield* sql`
        INSERT INTO office.recording_edits (recording_id, edited_by, edited_by_name, kind, change)
        VALUES (${RECORDING}, 'u1', 'Ada', 'title', '{"kind":"title","title":42}'::jsonb)
      `;

      yield* edits.submit(ada, RECORDING, { kind: "title", title: "Retro" });
      yield* edits.handlePending(handler);

      assert.deepStrictEqual(
        yield* sql`SELECT outcome, reason FROM office.recording_edits ORDER BY id`,
        [
          { outcome: "ignored", reason: "unreadable" },
          { outcome: "applied", reason: null },
        ],
      );
      assert.strictEqual(yield* titleOf, "Retro");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "leaves the edit pending and changes nothing when applying fails, so the retry applies it",
    () =>
      Effect.gen(function* () {
        const edits = yield* RecordingEdits;

        yield* recorded(null);

        const submitted = yield* edits.submit(ada, RECORDING, { kind: "title", title: "Retro" });
        const failing = yield* editHandler(true);

        const error = yield* edits.handlePending(failing.handler).pipe(Effect.flip);
        assert.strictEqual(error._tag, "StoreUnavailable");

        const id = Option.getOrThrow(submitted).id;
        assert.deepStrictEqual(yield* edits.find(ada, id), Option.some({ id, outcome: null }));
        assert.isNull(yield* titleOf);
        assert.deepStrictEqual(failing.committed, []);

        const working = yield* editHandler(false);
        yield* edits.handlePending(working.handler);

        assert.strictEqual(yield* titleOf, "Retro");
        assert.deepStrictEqual(working.committed, ["title by u1"]);
      }).pipe(Effect.provide(TestLayer)),
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

const EditHttpLayer = Layer.mergeAll(
  EditHandlers,
  RecordingHandlers,
  HttpServer.layerServices,
).pipe(Layer.provideMerge(SignedInTest), Layer.provideMerge(TestLayer));

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

  it.effect("starts with a title and agenda, tidied up, and treats blank ones as none", () =>
    Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(RecordingApi, ["recording"]);
      const sql = yield* SqlClient.SqlClient;

      yield* client.recording.submit({
        payload: { action: "start", title: "  Deploy \n  retro ", agenda: " \n" },
      });
      yield* client.recording.submit({ payload: { action: "start" } });

      assert.deepStrictEqual(
        yield* sql`SELECT title, agenda FROM office.recording_requests ORDER BY id`,
        [
          { title: "Deploy retro", agenda: null },
          { title: null, agenda: null },
        ],
      );

      const tooLong = yield* client.recording
        .submit({ payload: { action: "start", title: pipe("x", String.repeat(81)) } })
        .pipe(Effect.flip);

      assert.strictEqual(tooLong._tag, "SchemaError");
    }).pipe(Effect.provide(Layer.mergeAll(withSession("ada-session"), EditHttpLayer))),
  );

  it.effect(
    "submits an edit and looks it up, and answers 404 for a recording that doesn't exist",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpApiTest.groups(RecordingApi, ["edits"]);

        yield* recorded(null);

        const submitted = yield* client.edits.submit({
          params: { id: RECORDING },
          payload: { kind: "agenda", agenda: "What broke on Friday" },
        });

        assert.strictEqual(submitted.outcome, null);

        const found = yield* client.edits.find({ params: { id: submitted.id } });
        assert.deepStrictEqual(found, submitted);

        const missingEdit = yield* client.edits
          .find({ params: { id: submitted.id + 1 } })
          .pipe(Effect.flip);

        assert.strictEqual(missingEdit._tag, "EditNotFound");

        const missingRecording = yield* client.edits
          .submit({
            params: { id: "8c3d4e5f-1111-4c55-9a0e-8e3b8f9b2a10" },
            payload: { kind: "title", title: "Retro" },
          })
          .pipe(Effect.flip);

        assert.strictEqual(missingRecording._tag, "RecordingNotFound");
      }).pipe(Effect.provide(Layer.mergeAll(withSession("ada-session"), EditHttpLayer))),
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
