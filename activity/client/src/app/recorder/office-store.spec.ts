import { TestBed } from "@angular/core/testing";
import { type Observable, of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordingAction, RecordingStatus, RequestResult } from "./models";
import { OfficeStore } from "./office-store";
import { RecorderApi } from "./recorder-api";
import { RecorderSession } from "./session";
import { RECORDER_TIMING } from "./timing";

const idle: RecordingStatus = { botInOffice: true, occupants: [], recording: null };

const recording: RecordingStatus = {
  ...idle,
  recording: { id: "1", startedAt: "2026-10-27T12:00:00Z", startedByName: "Chris", endsAt: "2026-10-27T13:00:00Z" },
};

const pending: RequestResult = { id: 7, handled: false };

const fakeApi = () => ({
  state: vi.fn<() => Observable<RecordingStatus>>(() => of(idle)),
  requestRecording: vi.fn<(action: RecordingAction) => Observable<RequestResult>>(() => of(pending)),
  requestResult: vi.fn<(id: number) => Observable<RequestResult>>(() => of(pending)),
});

type FakeApi = ReturnType<typeof fakeApi>;

const fakeSession = () => ({ signIn: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) });

const setup = (api: FakeApi, session = fakeSession()) => {
  TestBed.configureTestingModule({
    providers: [OfficeStore, { provide: RecorderApi, useValue: api }, { provide: RecorderSession, useValue: session }],
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
    expect(api.state).not.toHaveBeenCalled();
  });

  it("loads the status after sign-in and keeps polling it", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    expect(store.phase()).toEqual({ kind: "idle" });
    expect(store.canPress()).toBe(true);
    expect(store.recording()).toBe(false);

    api.state.mockReturnValue(of(recording));
    await vi.advanceTimersByTimeAsync(timing.statePollMs);

    expect(store.phase()).toEqual({ kind: "recording", recording: recording.recording });
    expect(store.recording()).toBe(true);
  });

  it("reports when the bot is away", async () => {
    const api = fakeApi();
    api.state.mockReturnValue(of({ ...idle, botInOffice: false }));
    const { store } = await started(api);

    expect(store.phase()).toEqual({ kind: "away" });
    expect(store.canPress()).toBe(false);
  });

  it("keeps the last status and shows a notice when polling fails", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    api.state.mockReturnValue(throwError(() => new Error("/api/state answered 500")));
    await vi.advanceTimersByTimeAsync(timing.statePollMs);

    expect(store.status()).toEqual(idle);
    expect(store.notice()).toEqual({ kind: "error", text: "Couldn't reach the bot: /api/state answered 500" });
  });

  it("ticks the clock", async () => {
    const { store, timing } = await started(fakeApi());
    const before = store.now();

    await vi.advanceTimersByTimeAsync(timing.clockTickMs);

    expect(store.now()).toBe(before + timing.clockTickMs);
  });

  it("asks to start, waits for the bot, confirms and refreshes", async () => {
    const api = fakeApi();
    api.requestResult.mockReturnValue(of({ id: 7, handled: true, outcome: "started" }));
    const { store, timing } = await started(api);
    const polls = api.state.mock.calls.length;

    store.press();

    expect(store.busy()).toBe(true);
    expect(store.canPress()).toBe(false);

    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.requestRecording).toHaveBeenCalledWith("start");
    expect(api.requestResult).toHaveBeenCalledWith(7);
    expect(store.busy()).toBe(false);
    expect(store.notice()).toEqual({ kind: "info", text: "Recording started." });
    expect(api.state).toHaveBeenCalledTimes(polls + 1);
  });

  it("asks to stop while a recording runs", async () => {
    const api = fakeApi();
    api.state.mockReturnValue(of(recording));
    api.requestResult.mockReturnValue(of({ id: 7, handled: true, outcome: "stopped" }));
    const { store, timing } = await started(api);

    store.press();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.requestRecording).toHaveBeenCalledWith("stop");
  });

  it("ignores a second press while the first is in flight", async () => {
    const api = fakeApi();
    const { store } = await started(api);

    store.press();
    store.press();

    expect(api.requestRecording).toHaveBeenCalledTimes(1);
  });

  it("polls the request once a second and gives up when the bot never answers", async () => {
    const api = fakeApi();
    const { store, timing } = await started(api);

    store.press();
    await vi.advanceTimersByTimeAsync(timing.requestPollMs * (timing.requestPollLimit - 1));

    expect(api.requestResult).toHaveBeenCalledTimes(timing.requestPollLimit - 1);
    expect(store.busy()).toBe(true);

    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.requestResult).toHaveBeenCalledTimes(timing.requestPollLimit);
    expect(store.busy()).toBe(false);
    expect(store.notice()?.text).toBe("The bot hasn't answered yet. Try again in a moment.");
  });

  it("reports a request that couldn't be sent", async () => {
    const api = fakeApi();
    api.requestRecording.mockReturnValue(throwError(() => new Error("/api/recording answered 503")));
    const { store } = await started(api);

    store.press();

    expect(store.busy()).toBe(false);
    expect(store.notice()?.text).toBe("Couldn't reach the bot: /api/recording answered 503");
  });

  it("clears a notice after a while, counting from the latest one", async () => {
    const api = fakeApi();
    api.requestRecording.mockReturnValue(throwError(() => new Error("/api/recording answered 503")));
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
    const polls = api.state.mock.calls.length;

    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(timing.statePollMs * 3);

    expect(api.state).toHaveBeenCalledTimes(polls);
  });
});
