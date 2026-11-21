import { Schema } from "effect";

import { ListedRecording, type RecordingPage } from "../wire.ts";

export const HistoryList = Schema.Struct({
  recordings: Schema.Array(ListedRecording),
  older: Schema.NullOr(Schema.String),
  isPagedBack: Schema.Boolean,
});

export type HistoryList = typeof HistoryList.Type;

export const EMPTY_HISTORY: HistoryList = { recordings: [], older: null, isPagedBack: false };

const newestFirst = (recordings: Iterable<ListedRecording>): ReadonlyArray<ListedRecording> =>
  [...recordings].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

const merged = (
  known: ReadonlyArray<ListedRecording>,
  fresh: ReadonlyArray<ListedRecording>,
): ReadonlyArray<ListedRecording> =>
  newestFirst(new Map([...known, ...fresh].map((recording) => [recording.id, recording])).values());

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
