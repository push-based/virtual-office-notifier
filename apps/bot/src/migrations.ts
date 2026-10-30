import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

// Each flag turns into a pair of events in the voice_activity view.
const FLAG_EVENTS = [
  ["self_mute", "Muted", "Unmuted"],
  ["self_deaf", "Deafened", "Undeafened"],
  ["server_mute", "ServerMuted", "ServerUnmuted"],
  ["server_deaf", "ServerDeafened", "ServerUndeafened"],
  ["self_video", "CameraOn", "CameraOff"],
  ["streaming", "StreamStarted", "StreamStopped"],
] as const;

// A flag that's on as someone arrives counts as switched on, so the events
// alone say what state anyone was in. Leaving only says `Left`.
const flagEvents = FLAG_EVENTS.flatMap(([column, on, off]) => [
  `(CASE WHEN place.is_in AND s.new_${column} IS TRUE AND NOT (place.was_in AND s.old_${column} IS TRUE) THEN '${on}' END)`,
  `(CASE WHEN place.was_in AND place.is_in AND s.old_${column} IS TRUE AND s.new_${column} IS FALSE THEN '${off}' END)`,
]);

const voiceActivityView = `
  CREATE VIEW office.voice_activity AS
  SELECT
    s.id AS snapshot_id,
    s.observed_at,
    s.bot_session_id,
    s.user_id,
    m.display_name,
    m.real_name,
    e.event,
    s.old_channel_id,
    s.new_channel_id
  FROM office.voice_snapshots s
  JOIN office.members m USING (user_id)
  CROSS JOIN LATERAL (
    SELECT
      s.old_channel_id IS NOT DISTINCT FROM s.office_channel_id AS was_in,
      s.new_channel_id IS NOT DISTINCT FROM s.office_channel_id AS is_in
  ) AS place
  CROSS JOIN LATERAL (
    VALUES
      (CASE
        WHEN s.source = 'startup' THEN 'AlreadyThere'
        WHEN NOT place.was_in AND place.is_in THEN 'Joined'
      END),
      ${flagEvents.join(",\n      ")},
      (CASE WHEN place.was_in AND NOT place.is_in THEN 'Left' END)
  ) AS e(event)
  WHERE e.event IS NOT NULL
`;

const officeActivityView = `
  CREATE VIEW office.office_activity AS
  SELECT
    observed_at,
    bot_session_id,
    user_id,
    display_name,
    real_name,
    event,
    NULL::text AS detail,
    snapshot_id,
    NULL::bigint AS effect_id
  FROM office.voice_activity
  UNION ALL
  SELECT
    e.observed_at,
    e.bot_session_id,
    e.user_id,
    m.display_name,
    m.real_name,
    CASE
      WHEN e.sound_id IS NOT NULL THEN 'PlayedSound'
      WHEN e.emoji_id IS NOT NULL OR e.emoji_name IS NOT NULL THEN 'Reacted'
      ELSE 'SentEffect'
    END,
    CASE WHEN e.sound_id IS NOT NULL THEN e.sound_name ELSE e.emoji_name END,
    NULL::bigint,
    e.id
  FROM office.voice_effects e
  JOIN office.members m USING (user_id)
`;

// Keyed `<id>_<name>` and run once each, in id order, inside the `office`
// schema. They only ever add: nothing stored is ever deleted. Inlined rather
// than read from disk, because the VM only gets the bundled main.js.
export const migrations = Migrator.fromRecord({
  "0001_record_voice_activity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // One row per run of the bot, so "nobody was in the office" can be told
    // apart from "the bot wasn't watching". `stopped_at` stays null when it
    // didn't stop cleanly.
    yield* sql`
      CREATE TABLE office.bot_sessions (
        id uuid PRIMARY KEY,
        started_at timestamptz NOT NULL,
        stopped_at timestamptz
      )
    `;

    // The bot only ever writes `display_name` and `last_seen_at`. `real_name`
    // is filled in by hand.
    yield* sql`
      CREATE TABLE office.members (
        user_id text PRIMARY KEY,
        display_name text NOT NULL,
        real_name text,
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL
      )
    `;

    // Voice states as Discord sent them, before and after each update touching
    // the office. `startup` rows are people already there when the bot started.
    // `entry_id` is set by the bot, so a retried write is only stored once.
    yield* sql`
      CREATE TABLE office.voice_snapshots (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id uuid NOT NULL UNIQUE,
        bot_session_id uuid NOT NULL REFERENCES office.bot_sessions (id),
        source text NOT NULL CHECK (source IN ('update', 'startup')),
        observed_at timestamptz NOT NULL,
        guild_id text NOT NULL,
        office_channel_id text NOT NULL,
        user_id text NOT NULL REFERENCES office.members (user_id),
        old_channel_id text,
        new_channel_id text,
        old_self_mute boolean,
        new_self_mute boolean,
        old_self_deaf boolean,
        new_self_deaf boolean,
        old_server_mute boolean,
        new_server_mute boolean,
        old_server_deaf boolean,
        new_server_deaf boolean,
        old_self_video boolean,
        new_self_video boolean,
        old_streaming boolean,
        new_streaming boolean,
        old_suppress boolean,
        new_suppress boolean,
        old_request_to_speak_at timestamptz,
        new_request_to_speak_at timestamptz,
        old_session_id text,
        new_session_id text
      )
    `;

    yield* sql`CREATE INDEX voice_snapshots_observed_at ON office.voice_snapshots (observed_at)`;
    yield* sql`CREATE INDEX voice_snapshots_user_id_observed_at ON office.voice_snapshots (user_id, observed_at)`;

    // Updates that could never be written, kept so they can be replayed by hand.
    yield* sql`
      CREATE TABLE office.rejected_updates (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        rejected_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        error text NOT NULL
      )
    `;

    yield* sql.unsafe(voiceActivityView);
  }),

  "0002_record_banter_posts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.banter_posts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        posted_at timestamptz NOT NULL,
        period text NOT NULL
      )
    `;

    yield* sql`CREATE INDEX banter_posts_posted_at ON office.banter_posts (posted_at)`;
  }),

  "0003_record_voice_effects": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.voice_effects (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id uuid NOT NULL UNIQUE,
        bot_session_id uuid NOT NULL REFERENCES office.bot_sessions (id),
        observed_at timestamptz NOT NULL,
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        user_id text NOT NULL REFERENCES office.members (user_id),
        sound_id text,
        sound_name text,
        sound_volume double precision,
        emoji_id text,
        emoji_name text,
        emoji_animated boolean,
        animation_type integer,
        animation_id integer
      )
    `;

    yield* sql`CREATE INDEX voice_effects_observed_at ON office.voice_effects (observed_at)`;
    yield* sql`CREATE INDEX voice_effects_user_id_observed_at ON office.voice_effects (user_id, observed_at)`;

    yield* sql.unsafe(officeActivityView);
  }),

  "0004_answer_slack": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.responder_settings (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        enabled boolean NOT NULL DEFAULT false,
        clef_model text NOT NULL DEFAULT '@cf/cloudflare/clef' CHECK (clef_model <> ''),
        min_confidence double precision NOT NULL DEFAULT 0.7 CHECK (min_confidence BETWEEN 0 AND 1),
        max_replies_per_day integer NOT NULL DEFAULT 20 CHECK (max_replies_per_day >= 0),
        max_reactions_per_day integer NOT NULL DEFAULT 30 CHECK (max_reactions_per_day >= 0),
        max_replies_per_thread integer NOT NULL DEFAULT 3 CHECK (max_replies_per_thread >= 0),
        stale_after_seconds integer NOT NULL DEFAULT 120 CHECK (stale_after_seconds > 0),
        clef_thread_messages integer NOT NULL DEFAULT 10 CHECK (clef_thread_messages >= 0),
        writer_thread_messages integer NOT NULL DEFAULT 50 CHECK (writer_thread_messages >= 0),
        reaction_emoji text[] NOT NULL CHECK (
          cardinality(reaction_emoji) >= 2 AND array_position(reaction_emoji, '') IS NULL
        ),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    yield* sql`
      INSERT INTO office.responder_settings (reaction_emoji)
      VALUES (ARRAY['joy', 'eyes', 'raised_hands', 'heart', '+1', 'saluting_face'])
    `;

    yield* sql`ALTER TABLE office.members ADD COLUMN slack_user_id text UNIQUE`;

    yield* sql`
      CREATE TABLE office.slack_posts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id text NOT NULL,
        ts text NOT NULL,
        thread_ts text,
        kind text NOT NULL CHECK (kind IN ('Opened', 'Emptied', 'Reminder', 'Banter', 'Reply')),
        model text,
        posted_at timestamptz NOT NULL,
        UNIQUE (channel_id, ts)
      )
    `;

    yield* sql`CREATE INDEX slack_posts_posted_at ON office.slack_posts (posted_at)`;
    yield* sql`CREATE INDEX slack_posts_thread ON office.slack_posts (channel_id, thread_ts)`;

    yield* sql`
      CREATE TABLE office.slack_messages (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id text NOT NULL,
        ts text NOT NULL,
        thread_ts text NOT NULL,
        user_id text NOT NULL,
        display_name text NOT NULL,
        member_user_id text REFERENCES office.members (user_id),
        text text NOT NULL,
        is_mention boolean NOT NULL,
        received_at timestamptz NOT NULL
      )
    `;

    yield* sql`CREATE INDEX slack_messages_received_at ON office.slack_messages (received_at)`;

    yield* sql`
      CREATE TABLE office.slack_decisions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        message_id bigint NOT NULL REFERENCES office.slack_messages (id),
        decided_at timestamptz NOT NULL,
        clef_model text,
        clef_request jsonb,
        action text CHECK (action IN ('reply', 'react', 'ignore')),
        action_probabilities jsonb,
        action_confidence double precision,
        reaction text,
        reaction_probabilities jsonb,
        reaction_confidence double precision,
        latency_ms integer,
        min_confidence double precision NOT NULL,
        max_replies_per_day integer NOT NULL,
        max_reactions_per_day integer NOT NULL,
        max_replies_per_thread integer NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('replied', 'reacted', 'ignored')),
        reason text NOT NULL CHECK (
          reason IN (
            'clef', 'mention', 'low_confidence', 'daily_cap', 'thread_cap', 'outside_hours',
            'stale', 'superseded', 'clef_failed', 'no_model'
          )
        )
      )
    `;

    yield* sql`CREATE INDEX slack_decisions_decided_at ON office.slack_decisions (decided_at)`;

    yield* sql`
      CREATE TABLE office.slack_reactions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id text NOT NULL,
        item_ts text NOT NULL,
        user_id text NOT NULL,
        emoji text NOT NULL,
        added boolean NOT NULL,
        event_ts text NOT NULL,
        received_at timestamptz NOT NULL
      )
    `;

    yield* sql`CREATE INDEX slack_reactions_item ON office.slack_reactions (channel_id, item_ts)`;
  }),

  "0005_record_office_voice": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.recordings (
        id uuid PRIMARY KEY,
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        started_at timestamptz NOT NULL,
        started_by text NOT NULL REFERENCES office.members (user_id),
        stopped_at timestamptz,
        stop_reason text CHECK (stop_reason IN ('requested', 'office_emptied', 'time_limit', 'bot_restarted')),
        stopped_by text,
        transcript text,
        summary text,
        summary_model text,
        slack_channel_id text,
        slack_ts text,
        finished_at timestamptz
      )
    `;

    yield* sql`CREATE INDEX recordings_started_at ON office.recordings (started_at)`;
    yield* sql`CREATE UNIQUE INDEX recordings_active ON office.recordings ((true)) WHERE stopped_at IS NULL`;

    yield* sql`
      CREATE TABLE office.recording_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        recording_id uuid NOT NULL REFERENCES office.recordings (id),
        at timestamptz NOT NULL,
        event text NOT NULL CHECK (event IN ('started', 'resumed', 'stopped')),
        reason text,
        user_id text
      )
    `;

    yield* sql`CREATE INDEX recording_events_recording ON office.recording_events (recording_id, id)`;

    yield* sql`
      CREATE TABLE office.recording_requests (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        requested_at timestamptz NOT NULL DEFAULT now(),
        requested_by text NOT NULL,
        requested_by_name text NOT NULL,
        action text NOT NULL CHECK (action IN ('start', 'stop')),
        handled_at timestamptz,
        outcome text CHECK (outcome IN ('started', 'stopped', 'ignored')),
        reason text,
        recording_id uuid REFERENCES office.recordings (id)
      )
    `;

    yield* sql`CREATE INDEX recording_requests_pending ON office.recording_requests (id) WHERE handled_at IS NULL`;

    yield* sql`
      CREATE TABLE office.recording_clips (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        recording_id uuid NOT NULL REFERENCES office.recordings (id),
        user_id text NOT NULL REFERENCES office.members (user_id),
        started_at timestamptz NOT NULL,
        duration_ms integer NOT NULL CHECK (duration_ms >= 0),
        bytes integer NOT NULL CHECK (bytes >= 0),
        object_path text,
        transcription text NOT NULL DEFAULT 'pending' CHECK (transcription IN ('pending', 'done', 'skipped', 'failed')),
        transcript text,
        transcribed_at timestamptz,
        model text,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        UNIQUE (recording_id, user_id, started_at)
      )
    `;

    yield* sql`CREATE INDEX recording_clips_recording ON office.recording_clips (recording_id, started_at)`;
    yield* sql`CREATE INDEX recording_clips_pending ON office.recording_clips (id) WHERE transcription = 'pending'`;

    yield* sql`
      CREATE TABLE office.recording_status (
        id boolean PRIMARY KEY DEFAULT true CHECK (id),
        recording_id uuid REFERENCES office.recordings (id),
        bot_in_office boolean NOT NULL DEFAULT false,
        occupants jsonb NOT NULL DEFAULT '[]'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    yield* sql`INSERT INTO office.recording_status DEFAULT VALUES`;

    yield* sql`ALTER TABLE office.slack_posts DROP CONSTRAINT slack_posts_kind_check`;
    yield* sql`
      ALTER TABLE office.slack_posts
      ADD CONSTRAINT slack_posts_kind_check CHECK (kind IN ('Opened', 'Emptied', 'Reminder', 'Banter', 'Reply', 'Recording'))
    `;
  }),
});
