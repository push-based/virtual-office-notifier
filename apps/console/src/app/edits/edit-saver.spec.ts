import { TestBed } from "@angular/core/testing";
import { type Observable, of, throwError } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RECORDER_TIMING } from "../recorder/timing";
import { EditApi } from "./edit-api";
import { EditSaver } from "./edit-saver";
import type { RecordingChange, SubmittedEdit } from "./models";

const fakeApi = () => {
  let next = 0;

  return {
    submit: vi.fn<(recordingId: string, change: RecordingChange) => Observable<SubmittedEdit>>(
      () => {
        next += 1;

        return of({ id: next, outcome: null });
      },
    ),
    find: vi.fn<(id: number) => Observable<SubmittedEdit>>((id) => of({ id, outcome: null })),
  };
};

type FakeApi = ReturnType<typeof fakeApi>;

const setup = (api: FakeApi) => {
  TestBed.configureTestingModule({ providers: [EditSaver, { provide: EditApi, useValue: api }] });

  return { saver: TestBed.inject(EditSaver), timing: TestBed.inject(RECORDER_TIMING) };
};

const title: RecordingChange = { kind: "title", title: "Deploy retro" };

const agenda: RecordingChange = { kind: "agenda", agenda: "What broke" };

describe("EditSaver", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("is saving until the bot has applied every change, one after the other", async () => {
    const api = fakeApi();
    const { saver, timing } = setup(api);
    const sent = vi.fn();

    saver.save("r1", [title, agenda], sent);

    expect(saver.saving()).toBe(true);
    expect(api.submit.mock.calls).toEqual([["r1", title]]);

    api.find.mockImplementation((id) => of({ id, outcome: "applied" }));
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(api.submit.mock.calls).toEqual([
      ["r1", title],
      ["r1", agenda],
    ]);
    expect(saver.saving()).toBe(true);

    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(saver.saving()).toBe(false);
    expect(saver.notice()).toBeNull();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("finishes straight away when nothing changed", () => {
    const api = fakeApi();
    const { saver } = setup(api);
    const sent = vi.fn();

    saver.save("r1", [], sent);

    expect(api.submit).not.toHaveBeenCalled();
    expect(saver.saving()).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("explains a change the bot ignored", async () => {
    const api = fakeApi();
    api.find.mockImplementation((id) =>
      of({
        id,
        outcome: "ignored",
        reason: "silent",
        explanation: "Nobody spoke in that recording, so there's nothing to change.",
      }),
    );
    const { saver, timing } = setup(api);
    const sent = vi.fn();

    saver.save("r1", [title], sent);
    await vi.advanceTimersByTimeAsync(timing.requestPollMs);

    expect(saver.notice()?.text).toBe(
      "Nobody spoke in that recording, so there's nothing to change.",
    );
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("stops waiting after the answer window and says the bot will catch up", async () => {
    const api = fakeApi();
    const { saver, timing } = setup(api);
    const sent = vi.fn();

    saver.save("r1", [title], sent);
    await vi.advanceTimersByTimeAsync(timing.requestPollMs * timing.requestPollLimit);

    expect(api.find).toHaveBeenCalledTimes(timing.requestPollLimit);
    expect(saver.saving()).toBe(false);
    expect(saver.notice()?.text).toBe("The bot hasn't saved that yet. It will once it's back.");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("keeps the form open and says why when the change couldn't be sent", () => {
    const api = fakeApi();
    api.submit.mockReturnValue(
      throwError(() => new Error("/api/recordings/r1/edits answered 503")),
    );
    const { saver } = setup(api);
    const sent = vi.fn();

    saver.save("r1", [title], sent);

    expect(saver.saving()).toBe(false);
    expect(saver.notice()?.text).toBe(
      "Couldn't reach the bot: /api/recordings/r1/edits answered 503",
    );
    expect(sent).not.toHaveBeenCalled();
  });

  it("ignores a second save while the first is in flight", () => {
    const api = fakeApi();
    const { saver } = setup(api);

    saver.save("r1", [title], vi.fn());
    saver.save("r1", [agenda], vi.fn());

    expect(api.submit).toHaveBeenCalledTimes(1);
  });
});
