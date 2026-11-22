import { Array, DateTime, Schema } from "effect";

import { ListedRecording, type RecordingPage } from "office-domain/Recording";

export const HistoryList = Schema.Struct({
  recordings: Schema.Array(ListedRecording),
  older: Schema.NullOr(Schema.DateTimeUtcFromString),
  isPagedBack: Schema.Boolean,
});

export type HistoryList = typeof HistoryList.Type;

export const EMPTY_HISTORY: HistoryList = { recordings: [], older: null, isPagedBack: false };

const newestFirst = (recordings: Iterable<ListedRecording>): ReadonlyArray<ListedRecording> =>
  [...recordings].sort(
    (a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt),
  );

const merged = (
  known: ReadonlyArray<ListedRecording>,
  fresh: ReadonlyArray<ListedRecording>,
): ReadonlyArray<ListedRecording> =>
  newestFirst(
    new Map(Array.map([...known, ...fresh], (recording) => [recording.id, recording])).values(),
  );

export const withNewest = (list: HistoryList, page: RecordingPage): HistoryList => ({
  recordings: merged(list.recordings, page.recordings),
  older: list.isPagedBack ? list.older : page.older,
  isPagedBack: list.isPagedBack,
});

export const withOlder = (list: HistoryList, page: RecordingPage): HistoryList => ({
  recordings: merged(list.recordings, page.recordings),
  older: page.older,
  isPagedBack: true,
});
