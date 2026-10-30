import type { ListedRecording, RecordingPage } from "./models";

export interface HistoryList {
  readonly recordings: ReadonlyArray<ListedRecording>;
  readonly older: string | null;
  readonly pagedBack: boolean;
}

export const EMPTY_HISTORY: HistoryList = { recordings: [], older: null, pagedBack: false };

const newestFirst = (recordings: Iterable<ListedRecording>): ReadonlyArray<ListedRecording> =>
  [...recordings].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

const merged = (
  known: ReadonlyArray<ListedRecording>,
  fresh: ReadonlyArray<ListedRecording>,
): ReadonlyArray<ListedRecording> =>
  newestFirst(new Map([...known, ...fresh].map((recording) => [recording.id, recording])).values());

export const withNewest = (list: HistoryList, page: RecordingPage): HistoryList => ({
  recordings: merged(list.recordings, page.recordings),
  older: list.pagedBack ? list.older : page.older,
  pagedBack: list.pagedBack,
});

export const withOlder = (list: HistoryList, page: RecordingPage): HistoryList => ({
  recordings: merged(list.recordings, page.recordings),
  older: page.older,
  pagedBack: true,
});
