import { TestBed } from "@angular/core/testing";
import { CHECK_INTERVAL_MS, REQUEST_EXPIRY_MS } from "recording-requests/wire";
import { type Observable, of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RecordingStatus, RequestAction, SubmittedRequest } from "./models";
import { OfficeStore } from "./office-store";
import { RecorderApi } from "./recorder-api";
import { RecorderSession } from "./session";
import { RECORDER_TIMING } from "./timing";

const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [],
  recording: null,
  updatedAt: "2026-10-27T12:00:00Z",
};

const recording: RecordingStatus = {
  ...idle,
  recording: {
    id: "1",
    startedAt: "2026-10-27T12:00:00Z",
    startedByName: "Chris",
    endsAt: "2026-10-27T16:00:00Z",
    pause: null,
  },
};

const paused: RecordingStatus = {
  ...idle,
  recording: {
    id: "1",
    startedAt: "2026-10-27T12:00:00Z",
    startedByName: "Chris",
    endsAt: "2026-10-27T16:00:00Z",
    pause: { since: "2026-10-27T12:20:00Z", byName: "Ben" },
  },
};

const pending: SubmittedRequest = { id: 7, outcome: null };

const fakeApi = () => ({
  status: vi.fn<() => Observable<RecordingStatus>>(() => of(idle)),
  submit: vi.fn<(action: RequestAction) => Observable<SubmittedRequest>>(() => of(pending)),
  find: vi.fn<(id: number) => Observable<SubmittedRequest>>(() => of(pending)),
});

type FakeApi = ReturnType<typeof fakeApi>;

const fakeSession = () => ({ signIn: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) });

const setup = (api: FakeApi, session = fakeSession()) => {
  TestBed.configureTestingModule({
    providers: [
      OfficeStore,
      { provide: RecorderApi, useValue: api },
      { provide: RecorderSession, useValue: session },
    ],
  });

  return { store: TestBed.inject(OfficeStore), timing: TestBed.inject(RECORDER_TIMING) };
};

const started = async (api: FakeApi) => {
  const context = setup(api);

  await context.store.start();
  await vi.advanceTimersByTimeAsync(0);

  return context;
};

describe("OfficeStore", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("is connecting until the first status arrives", () => {
    const { store } = setup(fakeApi());

    expect(store.phase()).toEqual({ kind: "connecting" });
    expect(store.canPress()).toBe(false);
  });

  it("keeps the sign-in error and never polls when sign-in fails", async () => {
    const api = fakeApi();
    const session = fakeSession();
    session.signIn.mockRejectedValue(new Error("/api/config answered 502"));
    const { store } = setup(api, session);

    await store.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(store.phase()).toEqual({ kind: "failed", reason: "/api/config answered 502" });
    expect(api.status).not.toHaveBeenCalled();
  });

  it("loads the status after sign-in and keeps polling it", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    expect(store.phase()).toEqual({ kind: "idle" });
    expect(store.canPress()).toBe(true);
    expect(store.recording()).toBe(false);

    api.status.mockReturnValue(of(recording));
    await vi.advanceTimersByTimeAsync(timing.statePollMs);

    expect(store.phase()).toEqual({ kind: "recording", recording: recording.recording });
    expect(store.recording()).toBe(true);
  });

  it("reports when the bot is away", async () => {
    const api = fakeApi();
    api.status.mockReturnValue(of({ ...idle, botInOffice: false }));
    const { store } = await started(api);

    expect(store.phase()).toEqual({ kind: "away" });
    expect(store.canPress()).toBe(false);
  });

  it("keeps the last status and shows a notice when polling fails", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    api.status.mockReturnValue(throwError(() => new Error("/api/status answered 500")));
    await vi.advanceTimersByTimeAsync(timing.statePollMs);

    expect(store.status()).toEqual(idle);
    expect(store.notice()).toEqual({
      kind: "error",
      text: "Couldn't reach the bot: /api/status answered 500",
    });
  });

  it("ticks the clock", async () => {
    const { store, timing } = await started(fakeApi());
    const before = store.now();

    await vi.advanceTimersByTimeAsync(timing.clockTickMs);

    expect(store.now()).toBe(before + timing.clockTickMs);
  });

  it("asks to start, waits for the bot, confirms and refreshes", async () => {
    const api = fakeApi();
    api.find.mockReturnValue(of({ id: 7, outcome: "started" }));
    const { store, timing } = await started(api);
    const polls = api.status.mock.calls.length;

    store.press();

    expect(store.busy()).toBe(true);
    expect(store.canPress()).toBe(false);

    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.submit).toHaveBeenCalledWith("start");
    expect(api.find).toHaveBeenCalledWith(7);
    expect(store.busy()).toBe(false);
    expect(store.notice()).toEqual({ kind: "info", text: "Recording started." });
    expect(api.status).toHaveBeenCalledTimes(polls + 1);
  });

  it("asks to stop while a recording runs", async () => {
    const api = fakeApi();
    api.status.mockReturnValue(of(recording));
    api.find.mockReturnValue(of({ id: 7, outcome: "stopped" }));
    const { store, timing } = await started(api);

    store.press();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.submit).toHaveBeenCalledWith("stop");
  });

  it("asks to pause a running recording, and to resume a paused one", async () => {
    const api = fakeApi();
    api.status.mockReturnValue(of(recording));
    api.find.mockReturnValue(of({ id: 7, outcome: "paused" }));
    const { store, timing } = await started(api);

    expect(store.paused()).toBe(false);

    store.pressPause();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.submit).toHaveBeenLastCalledWith("pause");
    expect(store.notice()?.text).toBe("Recording paused. Nothing is captured until it's resumed.");

    api.status.mockReturnValue(of(paused));
    api.find.mockReturnValue(of({ id: 7, outcome: "resumed" }));
    await vi.advanceTimersByTimeAsync(timing.statePollMs);

    expect(store.phase()).toEqual({
      kind: "paused",
      recording: paused.recording,
      pause: paused.recording?.pause,
    });
    expect(store.paused()).toBe(true);
    expect(store.recording()).toBe(true);

    store.pressPause();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.submit).toHaveBeenLastCalledWith("resume");
  });

  it("stops a paused recording", async () => {
    const api = fakeApi();
    api.status.mockReturnValue(of(paused));
    const { store } = await started(api);

    store.press();

    expect(api.submit).toHaveBeenCalledWith("stop");
  });

  it("has nothing to pause while idle", async () => {
    const api = fakeApi();
    const { store } = await started(api);

    store.pressPause();

    expect(api.submit).not.toHaveBeenCalled();
  });

  it("ignores a second press while the first is in flight", async () => {
    const api = fakeApi();
    const { store } = await started(api);

    store.press();
    store.press();

    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it("polls the request once a second and gives up only after the bot would have ignored it", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    expect(timing.requestPollMs * timing.requestPollLimit).toBeGreaterThan(
      REQUEST_EXPIRY_MS + CHECK_INTERVAL_MS,
    );

    store.press();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs * (timing.requestPollLimit - 1));

    expect(api.find).toHaveBeenCalledTimes(timing.requestPollLimit - 1);
    expect(store.busy()).toBe(true);

    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.find).toHaveBeenCalledTimes(timing.requestPollLimit);
    expect(store.busy()).toBe(false);
    expect(store.notice()?.text).toBe("The bot hasn't answered yet. Try again in a moment.");
  });

  it("reports a request that couldn't be sent", async () => {
    const api = fakeApi();
    api.submit.mockReturnValue(throwError(() => new Error("/api/requests answered 503")));
    const { store } = await started(api);

    store.press();

    expect(store.busy()).toBe(false);
    expect(store.notice()?.text).toBe("Couldn't reach the bot: /api/requests answered 503");
  });

  it("clears a notice after a while, counting from the latest one", async () => {
    const api = fakeApi();
    api.submit.mockReturnValue(throwError(() => new Error("/api/requests answered 503")));
    const { store, timing } = await started(api);

    store.press();
    await vi.advanceTimersByTimeAsync(timing.noticeMs - 1);
    store.press();
    await vi.advanceTimersByTimeAsync(timing.noticeMs - 1);

    expect(store.notice()).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);

    expect(store.notice()).toBeNull();
  });

  it("stops polling once destroyed", async () => {
    const api = fakeApi();
    const { timing } = await started(api);
    const polls = api.status.mock.calls.length;

    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(timing.statePollMs * 3);

    expect(api.status).toHaveBeenCalledTimes(polls);
  });
});
