import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Effect, Layer, Option, String } from "effect";
import { SqlClient } from "effect/sql";

import { columnNaming, Database } from "../../src/database/Database.ts";
import { ErasureStore } from "../../src/erasure/ErasureStore.ts";
import { RecordingStore } from "../../src/recording/RecordingStore.ts";

const TestLayer = Layer.mergeAll(ErasureStore.layer, RecordingStore.layer).pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const OTHER = "7f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a11";

const SESSION = "11111111-1111-4111-8111-111111111111";

const minute = (n: number) => DateTime.makeUnsafe(n * 60_000);

const recordingBy = (id: string, startedBy: string, startedByName: string) =>
  Effect.gen(function* () {
    const store = yield* RecordingStore;

    yield* store.startRecording({
      id,
      guildId: "g1",
      channelId: "office",
      startedAt: minute(0),
      startedBy,
      startedByName,
      title: "Ada's planning",
      agenda: null,
      summaryStyle: "brief",
    });

    return store;
  });

const spoke = (
  recordingId: string,
  userId: string,
  displayName: string,
  at: number,
  said: string,
) =>
  Effect.gen(function* () {
    const store = yield* RecordingStore;

    const id = yield* store.addClip({
      recordingId,
      userId,
      displayName,
      startedAt: minute(at),
      durationMs: 2000,
      bytes: 100,
      objectPath: `recordings/${recordingId}/${userId}/${at}.ogg`,
      transcription: "pending",
    });

    yield* store.clipTranscribed(id, minute(at), said, "whisper");
  });

const finish = (id: string, slackTs: string) =>
  Effect.gen(function* () {
    const store = yield* RecordingStore;

    yield* store.stopRecording(id, minute(30), "requested", "u1");
    yield* store.recordActionItems(
      id,
      Option.some({ model: "m", items: [{ text: "send the deck", owner: "u1" }] }),
      minute(31),
    );
    yield* store.finishRecording(id, {
      transcript: "Ada: hello",
      writtenWith: { summaryStyle: "brief", agenda: null },
      summary: "• Ada said hello",
      summaryModel: "m",
      slackChannelId: "C1",
      slackTs,
      slackPermalink: null,
      finishedAt: minute(31),
    });
  });

const activity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`INSERT INTO office.bot_sessions (id, started_at) VALUES (${SESSION}, now())`;
  yield* sql`
    INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
    VALUES ('u2', 'Grace', now(), now())
    ON CONFLICT DO NOTHING
  `;

  for (const [index, userId] of ["u1", "u2"].entries())
    yield* sql`
      INSERT INTO office.voice_snapshots ${sql.insert({
        entryId: `00000000-0000-4000-8000-${String.padStart(12, "0")(`${index}`)}`,
        botSessionId: SESSION,
        source: "update",
        observedAt: DateTime.toDate(minute(index)),
        guildId: "g1",
        officeChannelId: "office",
        userId,
        oldChannelId: null,
        newChannelId: "office",
      })}
    `;

  yield* sql`UPDATE office.members SET slack_user_id = 'S1', real_name = 'Ada Lovelace' WHERE user_id = 'u1'`;
  yield* sql`
    INSERT INTO office.slack_messages
      (channel_id, ts, thread_ts, user_id, display_name, member_user_id, text, is_mention, received_at)
    VALUES
      ('C1', '5.1', '5.1', 'S1', 'ada', 'u1', 'morning all', false, now()),
      ('C1', '5.2', '5.1', 'S2', 'grace', NULL, 'morning <@S1>!', false, now())
  `;
  yield* sql`
    INSERT INTO office.slack_reactions (channel_id, item_ts, user_id, emoji, added, event_ts, received_at)
    VALUES ('C1', '5.2', 'S1', 'wave', true, '5.3', now()), ('C1', '5.1', 'S2', 'wave', true, '5.4', now())
  `;
  yield* sql`
    INSERT INTO office.slack_posts (channel_id, ts, thread_ts, kind, posted_at, text)
    VALUES ('C1', '6.1', NULL, 'Opened', now(), '*Ada Lovelace* opened the office'),
           ('C1', '6.2', '5.1', 'Reply', now(), 'Morning, Grace!')
  `;
});

const one = <A>(rows: ReadonlyArray<A>) => rows[0];

describe("ErasureStore", () => {
  it.effect("names everything it'll look for and the audio to delete", () =>
    Effect.gen(function* () {
      yield* recordingBy(RECORDING, "u1", "Ada");
      yield* spoke(RECORDING, "u1", "Ada", 1, "hello everyone");
      yield* activity;

      const subject = yield* (yield* ErasureStore).subject("u1");

      assert.deepStrictEqual(subject.slackUserIds, ["S1"]);
      assert.deepStrictEqual(subject.scrubber.needles, ["ada lovelace", "ada", "<@s1"]);
      assert.deepStrictEqual(subject.objectPaths, [`recordings/${RECORDING}/u1/1.ogg`]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("erases their own data and takes their name out of everyone else's", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* recordingBy(RECORDING, "u1", "Ada");
      yield* spoke(RECORDING, "u1", "Ada", 1, "hello everyone");
      yield* spoke(RECORDING, "u2", "Grace", 2, "hi Ada, nice to see you");
      yield* finish(RECORDING, "1.6");
      yield* recordingBy(OTHER, "u2", "Grace");
      yield* spoke(OTHER, "u2", "Grace", 3, "just me today");
      yield* finish(OTHER, "1.7");
      yield* activity;

      const erasures = yield* ErasureStore;
      const erased = yield* erasures.erase(yield* erasures.subject("u1"));

      assert.deepStrictEqual(erased, {
        objectPaths: [`recordings/${RECORDING}/u1/1.ogg`],
        republishing: 2,
      });

      const counts = one(
        yield* sql<Record<string, number>>`
          SELECT
            (SELECT count(*)::int FROM office.members WHERE user_id = 'u1') AS members,
            (SELECT count(*)::int FROM office.voice_snapshots WHERE user_id = 'u1') AS own_snapshots,
            (SELECT count(*)::int FROM office.voice_snapshots) AS snapshots,
            (SELECT count(*)::int FROM office.recording_clips WHERE user_id = 'u1') AS own_clips,
            (SELECT count(*)::int FROM office.slack_messages) AS messages,
            (SELECT count(*)::int FROM office.slack_reactions) AS reactions
        `,
      );

      assert.deepStrictEqual(counts, {
        members: 0,
        ownSnapshots: 0,
        snapshots: 1,
        ownClips: 0,
        messages: 1,
        reactions: 1,
      });

      const recording = one(
        yield* sql<{
          readonly startedBy: string;
          readonly title: string;
          readonly transcript: string | null;
          readonly summary: string | null;
          readonly republish: boolean;
          readonly actionItemsPulledAt: Date | null;
        }>`
          SELECT started_by, title, transcript, summary, republish_requested_at IS NOT NULL AS republish,
                 action_items_pulled_at
          FROM office.recordings WHERE id = ${RECORDING}
        `,
      );

      assert.deepStrictEqual(recording, {
        startedBy: "former_member",
        title: "a former member's planning",
        transcript: null,
        summary: null,
        republish: true,
        actionItemsPulledAt: null,
      });

      const other = one(
        yield* sql<{
          readonly transcript: string | null;
          readonly summary: string | null;
          readonly republish: boolean;
        }>`
          SELECT transcript, summary, republish_requested_at IS NOT NULL AS republish
          FROM office.recordings WHERE id = ${OTHER}
        `,
      );

      assert.deepStrictEqual(other, {
        transcript: null,
        summary: "• a former member said hello",
        republish: true,
      });

      const texts = yield* sql<{ readonly text: string }>`
        SELECT transcript AS text FROM office.recording_clips
        UNION ALL SELECT text FROM office.slack_messages
        UNION ALL SELECT text FROM office.slack_posts
        UNION ALL SELECT text FROM office.recording_action_items
        ORDER BY text
      `;

      assert.deepStrictEqual(
        Array.map(texts, ({ text }) => text),
        [
          "*a former member* opened the office",
          "Morning, Grace!",
          "hi a former member, nice to see you",
          "just me today",
          "morning a former member!",
          "send the deck",
        ],
      );

      const details = yield* (yield* RecordingStore).recordingDetails(RECORDING);

      assert.strictEqual(
        Option.map(details, ({ startedByName }) => startedByName).pipe(Option.getOrNull),
        "a former member",
      );
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("finds every channel and thread the bot posted in", () =>
    Effect.gen(function* () {
      yield* recordingBy(RECORDING, "u1", "Ada");
      yield* finish(RECORDING, "1.6");
      yield* activity;

      assert.deepStrictEqual(yield* (yield* ErasureStore).botPostings, {
        channels: ["C1"],
        threads: [
          { channel: "C1", ts: "1.6" },
          { channel: "C1", ts: "5.1" },
        ],
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("sweeps up activity written after the erasure", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* recordingBy(RECORDING, "u1", "Ada");
      yield* activity;

      const erasures = yield* ErasureStore;
      yield* erasures.erase(yield* erasures.subject("u1"));

      yield* sql`
        INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
        VALUES ('u1', 'Ada', now(), now())
      `;
      yield* sql`
        INSERT INTO office.voice_snapshots ${sql.insert({
          entryId: "00000000-0000-4000-8000-000000000099",
          botSessionId: SESSION,
          source: "update",
          observedAt: DateTime.toDate(minute(9)),
          guildId: "g1",
          officeChannelId: "office",
          userId: "u1",
          oldChannelId: "office",
          newChannelId: null,
        })}
      `;

      yield* erasures.sweep("u1");

      const left = yield* sql<{ readonly total: number }>`
        SELECT (SELECT count(*)::int FROM office.members WHERE user_id = 'u1')
             + (SELECT count(*)::int FROM office.voice_snapshots WHERE user_id = 'u1') AS total
      `;

      assert.strictEqual(left[0]?.total, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
