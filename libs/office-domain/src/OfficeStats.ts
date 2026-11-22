import { DateTime, Schema } from "effect";

export const OFFICE_TIME_ZONE = DateTime.zoneMakeOffset(2 * 60 * 60 * 1000);

export const StatsRange = Schema.Literals(["week", "month", "all"]);

export type StatsRange = typeof StatsRange.Type;

export const StatsQuery = Schema.Struct({ range: StatsRange });

export type StatsQuery = typeof StatsQuery.Type;

export const PersonTime = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  seconds: Schema.Finite,
  days: Schema.Int,
});

export type PersonTime = typeof PersonTime.Type;

export const PersonDays = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  days: Schema.Int,
});

export type PersonDays = typeof PersonDays.Type;

export const BusyHour = Schema.Struct({
  weekday: Schema.Int,
  hour: Schema.Int,
  people: Schema.Finite,
});

export type BusyHour = typeof BusyHour.Type;

export const SoundPlays = Schema.Struct({ sound: Schema.String, plays: Schema.Int });

export type SoundPlays = typeof SoundPlays.Type;

export const PlayerPlays = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  plays: Schema.Int,
});

export type PlayerPlays = typeof PlayerPlays.Type;

export const EmojiReactions = Schema.Struct({ emoji: Schema.String, reactions: Schema.Int });

export type EmojiReactions = typeof EmojiReactions.Type;

export const RecordingTotals = Schema.Struct({ count: Schema.Int, seconds: Schema.Finite });

export type RecordingTotals = typeof RecordingTotals.Type;

export const OfficeStats = Schema.Struct({
  range: StatsRange,
  since: Schema.NullOr(Schema.DateTimeUtcFromString),
  until: Schema.DateTimeUtcFromString,
  timeInOffice: Schema.Array(PersonTime),
  firstIn: Schema.Array(PersonDays),
  lastOut: Schema.Array(PersonDays),
  busiestHours: Schema.Array(BusyHour),
  sounds: Schema.Array(SoundPlays),
  players: Schema.Array(PlayerPlays),
  reactions: Schema.Array(EmojiReactions),
  recordings: RecordingTotals,
});

export type OfficeStats = typeof OfficeStats.Type;
