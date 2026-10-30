import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { type Observable, of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RecorderSession } from "../recorder/session";
import { listedRecording, recordingDetail } from "./fixtures";
import { HistoryApi } from "./history-api";
import { HistoryStore } from "./history-store";
import { HISTORY_TIMING } from "./history-timing";
import type { RecordingDetail, RecordingPage } from "./models";

const newest: RecordingPage = {
  recordings: [listedRecording({ id: "r2" })],
  older: "2026-10-29T12:05:00.000Z",
};

const oldest: RecordingPage = {
  recordings: [listedRecording({ id: "r1", startedAt: "2026-10-28T09:00:00.000Z" })],
  older: null,
};

const fakeApi = () => ({
  page: vi.fn<(before: string | null) => Observable<RecordingPage>>((before) =>
    of(before === null ? newest : oldest),
  ),
  recording: vi.fn<(id: string) => Observable<RecordingDetail>>(() =>
    of(recordingDetail({ id: "r2" })),
  ),
});

type FakeApi = ReturnType<typeof fakeApi>;

const fakeSession = () => ({
  token: signal<string | null>(null),
  openExternalLink: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
});

const setup = (api: FakeApi, session = fakeSession()) => {
  TestBed.configureTestingModule({
    providers: [
      HistoryStore,
      { provide: HistoryApi, useValue: api },
      { provide: RecorderSession, useValue: session },
    ],
  });

  return {
    store: TestBed.inject(HistoryStore),
    timing: TestBed.inject(HISTORY_TIMING),
    session,
  };
};

const signedIn = async (api: FakeApi) => {
  const context = setup(api);

  context.session.token.set("session-1");
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);

  return context;
};

describe("HistoryStore", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("waits for sign-in before loading anything", async () => {
    const api = fakeApi();
    const { store } = setup(api);

    TestBed.tick();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api.page).not.toHaveBeenCalled();
    expect(store.loaded()).toBe(false);
  });

  it("loads the newest recordings after sign-in and refreshes them every 15 seconds", async () => {
    const api = fakeApi();
    const { store, timing } = await signedIn(api);

    expect(timing.listPollMs).toBe(15_000);
    expect(store.loaded()).toBe(true);
    expect(store.recordings().map(({ id }) => id)).toEqual(["r2"]);
    expect(store.hasOlder()).toBe(true);

    api.page.mockReturnValue(
      of({
        ...newest,
        recordings: [
          listedRecording({ id: "r3", startedAt: "2026-10-30T09:00:00Z" }),
          ...newest.recordings,
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(timing.listPollMs);

    expect(store.recordings().map(({ id }) => id)).toEqual(["r3", "r2"]);
    expect(api.page).toHaveBeenCalledTimes(2);
  });

  it("shows older recordings from where the list ends", async () => {
    const api = fakeApi();
    const { store } = await signedIn(api);

    store.showOlder();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.page).toHaveBeenLastCalledWith("2026-10-29T12:05:00.000Z");
    expect(store.recordings().map(({ id }) => id)).toEqual(["r2", "r1"]);
    expect(store.hasOlder()).toBe(false);
    expect(store.loadingOlder()).toBe(false);
  });

  it("opens a recording, refreshing it every 5 seconds until it's finished", async () => {
    const api = fakeApi();
    api.recording.mockReturnValue(of(recordingDetail({ id: "r2", state: "transcribing" })));
    const { store, timing } = await signedIn(api);
    const listPolls = api.page.mock.calls.length;

    store.openRecording("r2");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.openId()).toBe("r2");
    expect(store.open()?.state).toBe("transcribing");

    api.recording.mockReturnValue(of(recordingDetail({ id: "r2", state: "finished" })));
    await vi.advanceTimersByTimeAsync(timing.recordingPollMs);

    expect(store.open()?.state).toBe("finished");

    await vi.advanceTimersByTimeAsync(timing.recordingPollMs * 3);

    expect(api.recording).toHaveBeenCalledTimes(2);
    expect(api.page).toHaveBeenCalledTimes(listPolls);
  });

  it("keeps refreshing a finished recording while its summary is being rewritten", async () => {
    const api = fakeApi();
    api.recording.mockReturnValue(of(recordingDetail({ id: "r2", rewriting: true })));
    const { store, timing } = await signedIn(api);

    store.openRecording("r2");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.open()?.rewriting).toBe(true);

    api.recording.mockReturnValue(
      of(recordingDetail({ id: "r2", summary: "• Rewritten", rewriting: false })),
    );
    await vi.advanceTimersByTimeAsync(timing.recordingPollMs);

    expect(store.open()?.summary).toBe("• Rewritten");

    await vi.advanceTimersByTimeAsync(timing.recordingPollMs * 3);

    expect(api.recording).toHaveBeenCalledTimes(2);
  });

  it("goes back to the list and refreshes it straight away", async () => {
    const api = fakeApi();
    const { store } = await signedIn(api);

    store.openRecording("r2");
    await vi.advanceTimersByTimeAsync(0);
    const listPolls = api.page.mock.calls.length;

    store.back();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.openId()).toBeNull();
    expect(store.open()).toBeNull();
    expect(api.page).toHaveBeenCalledTimes(listPolls + 1);
  });

  it("keeps what it has and says what went wrong when a refresh fails", async () => {
    const api = fakeApi();
    const { store, timing } = await signedIn(api);

    api.page.mockReturnValue(throwError(() => new Error("/api/recordings answered 503")));
    await vi.advanceTimersByTimeAsync(timing.listPollMs);

    expect(store.recordings().map(({ id }) => id)).toEqual(["r2"]);
    expect(store.failure()).toBe("/api/recordings answered 503");

    api.page.mockReturnValue(of(newest));
    await vi.advanceTimersByTimeAsync(timing.listPollMs);

    expect(store.failure()).toBeNull();
  });

  it("fetches the open recording again after an edit, even once it's finished", async () => {
    const api = fakeApi();
    const { store } = await signedIn(api);

    store.openRecording("r2");
    await vi.advanceTimersByTimeAsync(0);

    expect(api.recording).toHaveBeenCalledTimes(1);

    api.recording.mockReturnValue(of(recordingDetail({ id: "r2", title: "Deploy retro" })));
    store.refresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.recording).toHaveBeenCalledTimes(2);
    expect(store.open()?.title).toBe("Deploy retro");
  });

  it("opens the Slack summary outside the Activity", async () => {
    const { store, session } = await signedIn(fakeApi());

    store.openInSlack("https://office.slack.com/archives/C1/p12");

    expect(session.openExternalLink).toHaveBeenCalledWith(
      "https://office.slack.com/archives/C1/p12",
    );
  });
});
