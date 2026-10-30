import { describe, expect, it } from "vite-plus/test";

import { listedRecording } from "./fixtures";
import { EMPTY_HISTORY, withNewest, withOlder } from "./history-list";

const recordingAt = (minute: number, state: "running" | "finished" = "finished") =>
  listedRecording({
    id: `r${minute}`,
    state,
    startedAt: new Date(Date.UTC(2026, 9, 29, 12, minute)).toISOString(),
  });

const ids = (list: { readonly recordings: ReadonlyArray<{ readonly id: string }> }) =>
  list.recordings.map(({ id }) => id);

describe("the history list", () => {
  it("starts from the newest page and offers what's older", () => {
    const list = withNewest(EMPTY_HISTORY, {
      recordings: [recordingAt(3), recordingAt(2)],
      older: recordingAt(2).startedAt,
    });

    expect(ids(list)).toEqual(["r3", "r2"]);
    expect(list.older).toBe(recordingAt(2).startedAt);
  });

  it("adds older pages below and stops offering more at the end", () => {
    const first = withNewest(EMPTY_HISTORY, {
      recordings: [recordingAt(3), recordingAt(2)],
      older: recordingAt(2).startedAt,
    });

    const list = withOlder(first, { recordings: [recordingAt(1)], older: null });

    expect(ids(list)).toEqual(["r3", "r2", "r1"]);
    expect(list.older).toBeNull();
  });

  it("keeps the older pages and updates states when the newest page refreshes", () => {
    const paged = withOlder(
      withNewest(EMPTY_HISTORY, {
        recordings: [recordingAt(3, "running"), recordingAt(2)],
        older: recordingAt(2).startedAt,
      }),
      { recordings: [recordingAt(1)], older: null },
    );

    const refreshed = withNewest(paged, {
      recordings: [recordingAt(4, "running"), recordingAt(3)],
      older: recordingAt(3).startedAt,
    });

    expect(ids(refreshed)).toEqual(["r4", "r3", "r2", "r1"]);
    expect(refreshed.recordings[1]?.state).toBe("finished");
    expect(refreshed.older).toBeNull();
  });
});
