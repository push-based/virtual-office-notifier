import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Effect, Layer, Option, Schema, String } from "effect";
import { SqlClient } from "effect/sql";

import { stateOf } from "../src/Recording.ts";
import { PAGE_SIZE, RecordingHistory } from "../src/RecordingHistory.ts";
import { Occupant } from "../src/RecordingRequest.ts";
import { columnNaming } from "../src/SqlNaming.ts";

class ConnectionRefused extends Schema.TaggedError<
  ConnectionRefused,
  { readonly brand: unique symbol }
>()("ConnectionRefused", { message: Schema.String }) {}

const minute = (n: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, n));

const at = (n: number) => DateTime.toDate(minute(n));

const idFor = (n: number) => `00000000-0000-4000-8000-${String.padStart(12, "0")(`${n}`)}`;

const encodeOccupants = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Occupant)));

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE SCHEMA office`;
  yield* sql`
    CREATE TABLE office.members (user_id text PRIMARY KEY, display_name text NOT NULL, real_name text)
  `;
  yield* sql`
    CREATE TABLE office.recordings (
      id uuid PRIMARY KEY,
      started_at timestamptz NOT NULL,
      started_by text NOT NULL,
      stopped_at timestamptz,
      stop_reason text,
      stopped_by text,
      transcript text,
      summary text,
      summary_model text,
      slack_channel_id text,
      slack_ts text,
      slack_permalink text,
      finished_at timestamptz,
      title text,
      agenda text,
      action_items_pulled_at timestamptz,
      action_items_model text
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_action_items (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id uuid NOT NULL,
      position integer NOT NULL,
      text text NOT NULL,
      owner text,
      done boolean NOT NULL DEFAULT false,
      pulled_at timestamptz NOT NULL DEFAULT now(),
      replaced_at timestamptz
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_clips (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      recording_id uuid NOT NULL,
      user_id text NOT NULL,
      started_at timestamptz NOT NULL,
      transcription text NOT NULL DEFAULT 'pending',
      transcript text
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_status (
      recording_id uuid,
      bot_in_office boolean NOT NULL DEFAULT false,
      occupants jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  yield* sql`INSERT INTO office.recording_status DEFAULT VALUES`;
  yield* sql`
    INSERT INTO office.members ${sql.insert([
      { userId: "u1", displayName: "ada", realName: "Ada" },
      { userId: "u2", displayName: "grace", realName: null },
      { userId: "u3", displayName: "linus", realName: "Linus" },
    ])}
  `;

  return sql;
});

interface RecordingRow {
  readonly id: string;
  readonly startedAt: Date;
  readonly startedBy: string;
  readonly stoppedAt?: Date;
  readonly stopReason?: string;
  readonly stoppedBy?: string;
  readonly summary?: string;
  readonly summaryModel?: string;
  readonly slackChannelId?: string;
  readonly slackTs?: string;
  readonly slackPermalink?: string;
  readonly finishedAt?: Date;
  readonly title?: string;
  readonly agenda?: string;
  readonly actionItemsPulledAt?: Date;
  readonly actionItemsModel?: string;
}

const insertRecording = (sql: SqlClient.SqlClient, row: RecordingRow) =>
  sql`INSERT INTO office.recordings ${sql.insert({ ...row })}`;

const insertClip = (
  sql: SqlClient.SqlClient,
  recordingId: string,
  userId: string,
  startedAt: Date,
  transcription: string,
  transcript: string | null,
) =>
  sql`
    INSERT INTO office.recording_clips ${sql.insert({ recordingId, userId, startedAt, transcription, transcript })}
  `;

const TestLayer = RecordingHistory.layer.pipe(Layer.provideMerge(PgliteClient.layer(columnNaming)));

const RUNNING = idFor(4);

const TRANSCRIBING = idFor(3);

const FINISHED = idFor(2);

const SILENT = idFor(1);

const fourStates = Effect.gen(function* () {
  const sql = yield* createTables;

  yield* insertRecording(sql, {
    id: SILENT,
    startedAt: at(0),
    startedBy: "u1",
    stoppedAt: at(5),
    stopReason: "office_emptied",
    finishedAt: at(6),
  });
  yield* insertRecording(sql, {
    id: FINISHED,
    startedAt: at(10),
    startedBy: "u2",
    stoppedAt: at(40),
    stopReason: "requested",
    stoppedBy: "u3",
    summary: "• Ada said hello",
    summaryModel: "model",
    slackChannelId: "C1",
    slackTs: "1.2",
    slackPermalink: "https://office.slack.com/archives/C1/p12",
    finishedAt: at(41),
    title: "Deploy retro",
    agenda: "What broke on Friday",
    actionItemsPulledAt: at(41),
    actionItemsModel: "model",
  });
  yield* sql`
    INSERT INTO office.recording_action_items ${sql.insert([
      { recordingId: FINISHED, position: 1, text: "ask IT about the VPN", owner: null },
      { recordingId: FINISHED, position: 0, text: "write up the deploy checklist", owner: "u1" },
    ])}
  `;
  yield* sql`
    INSERT INTO office.recording_action_items ${sql.insert({
      recordingId: FINISHED,
      position: 2,
      text: "an earlier pull",
      owner: "u3",
      replacedAt: at(42),
    })}
  `;
  yield* sql`UPDATE office.recording_action_items SET done = true WHERE owner = 'u1'`;
  yield* insertRecording(sql, {
    id: TRANSCRIBING,
    startedAt: at(50),
    startedBy: "u1",
    stoppedAt: at(55),
    stopReason: "time_limit",
  });
  yield* insertRecording(sql, { id: RUNNING, startedAt: at(60), startedBy: "u3" });

  yield* insertClip(sql, FINISHED, "u3", at(12), "done", "Morning");
  yield* insertClip(sql, FINISHED, "u1", at(11), "done", "Hello");
  yield* insertClip(sql, FINISHED, "u1", at(13), "done", "How are you?");
  yield* insertClip(sql, FINISHED, "u2", at(14), "skipped", null);
  yield* insertClip(sql, FINISHED, "u2", at(15), "failed", null);
  yield* insertClip(sql, FINISHED, "u3", at(16), "done", "   ");
  yield* insertClip(sql, TRANSCRIBING, "u2", at(51), "done", "First");
  yield* insertClip(sql, TRANSCRIBING, "u1", at(52), "pending", null);
  yield* insertClip(sql, SILENT, "u1", at(1), "skipped", null);

  const occupants = yield* encodeOccupants([
    { userId: "u1", displayName: "ada", avatarUrl: "https://cdn.example/ada.png", speaking: true },
    { userId: "u3", displayName: "linus", avatarUrl: null, speaking: false },
  ]);

  yield* sql`UPDATE office.recording_status SET occupants = ${occupants}::jsonb`;

  return yield* RecordingHistory;
});

describe("stateOf", () => {
  it("tells running, transcribing, finished and silent recordings apart", () => {
    assert.strictEqual(stateOf({ stopped: false, finished: false, posted: false }), "running");
    assert.strictEqual(stateOf({ stopped: true, finished: false, posted: false }), "transcribing");
    assert.strictEqual(stateOf({ stopped: true, finished: true, posted: true }), "finished");
    assert.strictEqual(stateOf({ stopped: true, finished: true, posted: false }), "silent");
  });
});

describe("RecordingHistory.page", () => {
  it.effect("lists every recording newest first, in every state", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;
      const page = yield* history.page(Option.none());

      assert.deepStrictEqual(
        Array.map(page.recordings, ({ id, state }) => [id, state]),
        [
          [RUNNING, "running"],
          [TRANSCRIBING, "transcribing"],
          [FINISHED, "finished"],
          [SILENT, "silent"],
        ],
      );
      assert.isNull(page.older);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("says who started each one and who spoke, in the order they first spoke", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;
      const page = yield* history.page(Option.none());
      const byId = new Map(Array.map(page.recordings, (recording) => [recording.id, recording]));

      const finished = byId.get(FINISHED);
      assert.deepStrictEqual(finished?.startedBy, { userId: "u2", name: "grace", avatarUrl: null });
      assert.deepStrictEqual(finished?.startedAt, minute(10));
      assert.deepStrictEqual(finished?.stoppedAt, minute(40));
      assert.deepStrictEqual(finished?.speakers, [
        { userId: "u1", name: "Ada", avatarUrl: "https://cdn.example/ada.png" },
        { userId: "u3", name: "Linus", avatarUrl: null },
      ]);

      assert.deepStrictEqual(
        Array.map(byId.get(TRANSCRIBING)?.speakers ?? [], ({ name }) => name),
        ["grace", "Ada"],
      );
      assert.deepStrictEqual(byId.get(SILENT)?.speakers, []);
      assert.strictEqual(finished?.title, "Deploy retro");
      assert.isNull(byId.get(RUNNING)?.title);
      assert.deepStrictEqual(byId.get(RUNNING)?.speakers, []);
      assert.isNull(byId.get(RUNNING)?.stoppedAt);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("pages through older recordings by start time, 20 at a time", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;

      for (const n of Array.range(1, PAGE_SIZE + 5)) {
        yield* insertRecording(sql, { id: idFor(n), startedAt: at(n), startedBy: "u1" });
      }

      const history = yield* RecordingHistory;
      const first = yield* history.page(Option.none());

      assert.strictEqual(first.recordings.length, PAGE_SIZE);
      assert.strictEqual(first.recordings[0]?.id, idFor(PAGE_SIZE + 5));
      assert.deepStrictEqual(first.older, minute(6));

      const second = yield* history.page(Option.fromNullOr(first.older));

      assert.deepStrictEqual(
        Array.map(second.recordings, ({ id }) => id),
        [idFor(5), idFor(4), idFor(3), idFor(2), idFor(1)],
      );
      assert.isNull(second.older);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("has nothing older when the last page is exactly full", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;

      for (const n of Array.range(1, PAGE_SIZE)) {
        yield* insertRecording(sql, { id: idFor(n), startedAt: at(n), startedBy: "u1" });
      }

      const page = yield* (yield* RecordingHistory).page(Option.none());

      assert.strictEqual(page.recordings.length, PAGE_SIZE);
      assert.isNull(page.older);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("RecordingHistory.find", () => {
  it.effect("gives a recording's summary, link, how it stopped and its transcribed clips", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;
      const found = yield* history.find(FINISHED);

      assert.isTrue(Option.isSome(found));

      const detail = Option.getOrThrow(found);

      assert.strictEqual(detail.state, "finished");
      assert.strictEqual(detail.stopReason, "requested");
      assert.deepStrictEqual(detail.stoppedBy, { userId: "u3", name: "Linus", avatarUrl: null });
      assert.strictEqual(detail.title, "Deploy retro");
      assert.strictEqual(detail.agenda, "What broke on Friday");
      assert.strictEqual(detail.summary, "• Ada said hello");
      assert.strictEqual(detail.summaryModel, "model");
      assert.strictEqual(detail.slackPermalink, "https://office.slack.com/archives/C1/p12");
      assert.deepStrictEqual(
        Array.map(detail.clips, ({ speaker, startedAt, text }) => [speaker.name, startedAt, text]),
        [
          ["Ada", minute(11), "Hello"],
          ["Linus", minute(12), "Morning"],
          ["Ada", minute(13), "How are you?"],
        ],
      );
      assert.strictEqual(detail.clips[0]?.speaker.avatarUrl, "https://cdn.example/ada.png");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "gives the current action items in order with their owners, and everyone they can be given to",
    () =>
      Effect.gen(function* () {
        const history = yield* fourStates;
        const detail = Option.getOrThrow(yield* history.find(FINISHED));

        assert.deepStrictEqual(
          Array.map(detail.actionItems ?? [], ({ text, owner, done }) => ({ text, owner, done })),
          [
            {
              text: "write up the deploy checklist",
              owner: { userId: "u1", name: "Ada", avatarUrl: "https://cdn.example/ada.png" },
              done: true,
            },
            { text: "ask IT about the VPN", owner: null, done: false },
          ],
        );
        assert.deepStrictEqual(
          Array.map(detail.members, ({ name }) => name),
          ["Ada", "grace", "Linus"],
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("still gives the recording when its action items can't be read", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`ALTER TABLE office.recording_action_items RENAME TO unreadable_action_items`;

      const detail = Option.getOrThrow(yield* history.find(FINISHED));
      assert.isNull(detail.actionItems);
      assert.strictEqual(detail.summary, "• Ada said hello");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("has no action items for a recording none could be pulled out of", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;

      assert.isNull(Option.getOrThrow(yield* history.find(TRANSCRIBING)).actionItems);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("gives the transcript so far while a recording is still transcribing", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;
      const detail = Option.getOrThrow(yield* history.find(TRANSCRIBING));

      assert.strictEqual(detail.state, "transcribing");
      assert.strictEqual(detail.stopReason, "time_limit");
      assert.isNull(detail.stoppedBy);
      assert.isNull(detail.title);
      assert.isNull(detail.agenda);
      assert.isNull(detail.summary);
      assert.isNull(detail.slackPermalink);
      assert.deepStrictEqual(
        Array.map(detail.clips, ({ text }) => text),
        ["First"],
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds nothing for a recording that doesn't exist", () =>
    Effect.gen(function* () {
      const history = yield* fourStates;

      assert.deepStrictEqual(yield* history.find(idFor(99)), Option.none());
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("RecordingHistory.layerPerCall", () => {
  it.effect("answers as unavailable when it can't connect", () =>
    Effect.gen(function* () {
      const history = yield* Effect.provide(
        Effect.service(RecordingHistory),
        RecordingHistory.layerPerCall(
          Layer.effect(
            SqlClient.SqlClient,
            Effect.fail(ConnectionRefused.make({ message: "Connection refused" })),
          ),
        ),
      );

      const failures = yield* Effect.all([
        history.page(Option.none()).pipe(Effect.flip),
        history.find(FINISHED).pipe(Effect.flip),
      ]);

      for (const failure of failures) {
        assert.strictEqual(failure._tag, "RecordingUnavailable");
        assert.strictEqual(failure.reason, "Connection refused");
      }
    }),
  );
});
