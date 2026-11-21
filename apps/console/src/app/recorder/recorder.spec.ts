import { identity, Option } from "effect";
import { Scene, Story } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import { describe, expect, it } from "vite-plus/test";

import type { RecordingStatus, RunningRecording } from "../wire.ts";
import {
  Connection,
  FetchStatus,
  init,
  Message,
  type Model,
  pollInterval,
  ShowPresence,
  SubmitRequest,
  update,
  view,
  WaitBeforeDismissal,
} from "./recorder.ts";

const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [{ userId: "u2", displayName: "Ben", avatarUrl: null, speaking: false }],
  recording: null,
  updatedAt: "2026-10-27T12:00:00Z",
};

const chris: RunningRecording = {
  id: "r1",
  startedAt: "2026-10-27T12:00:00Z",
  startedByName: "Chris",
  endsAt: "2026-10-27T16:00:00Z",
  pause: null,
  title: "Deploy retro",
  agenda: null,
  summaryStyle: "brief",
};

const recording: RecordingStatus = { ...idle, recording: chris };

const paused: RecordingStatus = {
  ...idle,
  recording: { ...chris, pause: { since: "2026-10-27T12:20:00Z", byName: "Ben" } },
};

const loaded = (status: RecordingStatus): Model =>
  modifyFields(init(), {
    connection: () => Connection.Loaded({ status }),
    presence: () => Option.none(),
  });

const now = Date.parse("2026-10-27T12:12:34Z");

const scene = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    h.submodel({ slotId: "recorder", model, view, viewInputs: { now }, toParentMessage: identity }),
};

describe("the recorder", () => {
  it("is connecting until signed in and the first status arrives", () => {
    Scene.scene(
      scene,
      Scene.given(init()),
      Scene.expect(Scene.role("heading", { name: "Connecting…" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Start recording" })).toBeDisabled(),
    );
  });

  it("keeps the sign-in error and never polls when sign-in fails", () => {
    const failed = modifyFields(init(), {
      connection: () => Connection.FailedSignIn({ reason: "/api/config answered 502" }),
    });

    expect(pollInterval(failed)).toEqual(Option.none());
    Scene.scene(
      scene,
      Scene.given(failed),
      Scene.expect(Scene.role("heading", { name: "Couldn't start" })).toExist(),
      Scene.expect(Scene.text("/api/config answered 502")).toExist(),
    );
  });

  it("asks for the status one request at a time, and ignores an answer older than the last", () => {
    Story.story(
      update,
      Story.given(loaded(recording)),
      Story.message(Message.TickedStatusPoll()),
      Story.Command.expectExact(FetchStatus({ request: 1 })),
      Story.Command.resolve(
        FetchStatus,
        Message.SucceededFetchStatus({ request: 1, status: recording }),
      ),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
      Story.message(Message.SucceededFetchStatus({ request: 1, status: idle })),
      Story.model((model) =>
        expect(model.connection).toEqual(Connection.Loaded({ status: recording })),
      ),
    );
    Story.story(
      update,
      Story.given(modifyFields(loaded(recording), { statusRequests: () => 1 })),
      Story.message(Message.TickedStatusPoll()),
      Story.Command.expectNone(),
    );
  });

  it("closes the editor when the recording it was editing ends", () => {
    const editing = modifyFields(loaded(recording), {
      editor: () => ({
        ...init().editor,
        draft: Option.some({ title: "Deploy retro", agenda: "", summaryStyle: "brief" }),
      }),
    });

    Story.story(
      update,
      Story.given(editing),
      Story.message(Message.SucceededFetchStatus({ request: 1, status: idle })),
      Story.model((model) => expect(model.editor.draft).toEqual(Option.none())),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
    );
  });

  it("polls every three seconds, and every second while recording", () => {
    expect(pollInterval(modifyFields(init(), { connection: () => Connection.Loading() }))).toEqual(
      Option.some(3000),
    );
    expect(pollInterval(loaded(idle))).toEqual(Option.some(3000));
    expect(pollInterval(loaded(recording))).toEqual(Option.some(1000));
  });

  it("shows the office in the Rich Presence once per phase", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.SucceededFetchStatus({ request: 1, status: idle })),
      Story.Command.expectExact(
        ShowPresence({
          presence: { details: "In the office", state: "Not recording", timestamps: null },
        }),
      ),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
      Story.message(
        Message.SucceededFetchStatus({ request: 2, status: { ...idle, occupants: [] } }),
      ),
      Story.Command.expectNone(),
    );
  });

  it("keeps the last status and shows a notice when polling fails", () => {
    Story.story(
      update,
      Story.given(loaded(idle)),
      Story.message(Message.FailedFetchStatus({ request: 1, reason: "/api/status answered 500" })),
      Story.model((model) => {
        expect(model.connection).toEqual(Connection.Loaded({ status: idle }));
        expect(Option.map(model.notice, ({ notice }) => notice)).toEqual(
          Option.some({ kind: "error", text: "Couldn't reach the bot: /api/status answered 500" }),
        );
      }),
      Story.Command.expectExact(WaitBeforeDismissal({ id: 1 })),
      Story.Command.resolve(WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })),
    );
  });

  it("starts with the title and agenda tidied up, waits for the bot, confirms and refreshes", () => {
    const planned = modifyFields(loaded(idle), {
      draft: () => ({
        title: "  Deploy   retro ",
        agenda: " What went wrong \n",
        summaryStyle: "brief",
      }),
    });

    Scene.scene(
      scene,
      Scene.given(planned),
      Scene.click(Scene.role("button", { name: "Start recording" })),
      Scene.expect(Scene.role("button", { name: "Start recording" })).toHaveAttr(
        "aria-busy",
        "true",
      ),
      Scene.Command.expectExact(
        SubmitRequest({
          submission: {
            action: "start",
            title: "Deploy retro",
            agenda: "What went wrong",
            summaryStyle: "brief",
          },
        }),
      ),
      Scene.Command.resolve(
        SubmitRequest,
        Message.CompletedSubmitRequest({ handled: { id: 7, outcome: "started" } }),
      ),
      Scene.expect(Scene.text("Recording started.")).toExist(),
      Scene.Command.expectExact(WaitBeforeDismissal({ id: 1 }), FetchStatus({ request: 1 })),
      Scene.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 1, status: recording })],
      ),
      Scene.expect(Scene.text("Recording started.")).toBeAbsent(),
      Scene.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
    );
  });

  it("clears the title and agenda once the recording started", () => {
    Story.story(
      update,
      Story.given(
        modifyFields(loaded(idle), {
          isSubmitting: () => true,
          draft: () => ({ title: "Retro", agenda: "Plans", summaryStyle: "detailed" }),
        }),
      ),
      Story.message(Message.CompletedSubmitRequest({ handled: { id: 7, outcome: "started" } })),
      Story.model((model) =>
        expect(model.draft).toEqual({ title: "", agenda: "", summaryStyle: "brief" }),
      ),
      Story.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 1, status: recording })],
      ),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
    );
  });

  it("keeps the title and agenda when the bot didn't start the recording", () => {
    Story.story(
      update,
      Story.given(loaded(idle)),
      Story.message(Message.UpdatedDraftTitle({ value: "Retro" })),
      Story.message(Message.ClickedRecord()),
      Story.Command.resolve(
        SubmitRequest,
        Message.CompletedSubmitRequest({
          handled: {
            id: 7,
            outcome: "ignored",
            reason: "already_recording",
            explanation: "Someone already started a recording.",
          },
        }),
      ),
      Story.model((model) => {
        expect(model.draft.title).toBe("Retro");
        expect(model.isSubmitting).toBe(false);
      }),
      Story.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 1, status: idle })],
      ),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
    );
  });

  it("shows the running recording with its title, and asks to stop or pause it", () => {
    Scene.scene(
      scene,
      Scene.given(loaded(recording)),
      Scene.expect(Scene.role("heading", { name: "Recording · 00:12:34" })).toExist(),
      Scene.expect(Scene.text("Deploy retro")).toExist(),
      Scene.expect(Scene.text("Started by Chris · 3h 48m left")).toExist(),
      Scene.expect(Scene.text("In the office · 1")).toExist(),
      Scene.click(Scene.role("button", { name: "Pause" })),
      Scene.Command.expectExact(SubmitRequest({ submission: { action: "pause" } })),
      Scene.Command.resolve(
        SubmitRequest,
        Message.CompletedSubmitRequest({ handled: { id: 8, outcome: "paused" } }),
      ),
      Scene.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 1, status: paused })],
      ),
      Scene.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
      Scene.expect(Scene.role("heading", { name: "Paused by Ben · 0m" })).toExist(),
      Scene.click(Scene.role("button", { name: "Stop recording" })),
      Scene.Command.expectExact(SubmitRequest({ submission: { action: "stop" } })),
      Scene.Command.resolve(SubmitRequest, Message.FailedSubmitRequest({ reason: "x" })),
      Scene.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 2 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 2, status: paused })],
      ),
    );
  });

  it("asks to resume a paused recording", () => {
    Story.story(
      update,
      Story.given(loaded(paused)),
      Story.message(Message.ClickedPause()),
      Story.Command.expectExact(SubmitRequest({ submission: { action: "resume" } })),
      Story.Command.resolve(SubmitRequest, Message.FailedSubmitRequest({ reason: "x" })),
      Story.Command.resolveAll(
        [WaitBeforeDismissal, Message.CompletedWaitBeforeDismissal({ id: 1 })],
        [FetchStatus, Message.SucceededFetchStatus({ request: 1, status: paused })],
      ),
      Story.Command.resolve(ShowPresence, Message.CompletedShowPresence()),
    );
  });

  it("has nothing to pause while idle, and nothing to press while the bot is away", () => {
    Story.story(
      update,
      Story.given(loaded(idle)),
      Story.message(Message.ClickedPause()),
      Story.Command.expectNone(),
    );
    Story.story(
      update,
      Story.given(loaded({ ...idle, botInOffice: false })),
      Story.message(Message.ClickedRecord()),
      Story.Command.expectNone(),
    );
  });

  it("ignores a second press while the first is in flight", () => {
    Story.story(
      update,
      Story.given(modifyFields(loaded(idle), { isSubmitting: () => true })),
      Story.message(Message.ClickedRecord()),
      Story.Command.expectNone(),
    );
  });

  it("clears a notice after a while, counting from the latest one", () => {
    const shown = modifyFields(loaded(idle), {
      notice: () => Option.some({ id: 2, notice: { kind: "info", text: "Recording resumed." } }),
      noticeCount: () => 2,
    });

    Story.story(
      update,
      Story.given(shown),
      Story.message(Message.CompletedWaitBeforeDismissal({ id: 1 })),
      Story.model((model) => expect(Option.isSome(model.notice)).toBe(true)),
      Story.message(Message.CompletedWaitBeforeDismissal({ id: 2 })),
      Story.model((model) => expect(model.notice).toEqual(Option.none())),
    );
  });
});
