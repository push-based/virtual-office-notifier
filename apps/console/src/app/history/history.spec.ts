import { identity, Option } from "effect";
import { Scene, Story } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vite-plus/test";

import * as RecordingEditor from "../edits/recording-editor.ts";
import * as SummaryRewrite from "../edits/summary-rewrite.ts";
import { listedRecording, recordingDetail } from "./fixtures.ts";
import {
  FetchNewest,
  FetchOlder,
  FetchRecording,
  init,
  Message,
  type Model,
  OpenInSlack,
  polledRecordingId,
  update,
  view,
} from "./history.ts";

const now = Date.parse("2026-10-29T14:00:00.000Z");

const scene = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    h.submodel({ slotId: "history", model, view, viewInputs: { now }, toParentMessage: identity }),
};

const page = (recordings = [listedRecording()], older: string | null = null) => ({
  recordings,
  older,
});

const listed = (recordings = [listedRecording()], older: string | null = null): Model =>
  update(init(), Message.SucceededFetchNewest({ request: 1, page: page(recordings, older) })).model;

const opened = (detail = recordingDetail()): Model =>
  update(
    update(listed(), Message.ClickedRecording({ id: detail.id })).model,
    Message.SucceededFetchRecording({ id: detail.id, request: 1, recording: detail }),
  ).model;

describe("the recording history", () => {
  it("shows nothing until the first page arrives, then says when nothing was recorded", () => {
    Story.story(
      update,
      Story.given(init()),
      Story.message(Message.TickedListPoll()),
      Story.Command.expectExact(FetchNewest({ request: 1 })),
      Story.Command.resolve(
        FetchNewest,
        Message.SucceededFetchNewest({ request: 1, page: page([]) }),
      ),
      Story.model((model) => expect(model.isLoaded).toBe(true)),
    );
    Scene.scene(
      scene,
      Scene.given(listed([])),
      Scene.expect(Scene.text("Nothing has been recorded yet.")).toExist(),
    );
  });

  it("lists every recording with its state, and only opens those with something to show", () => {
    Scene.scene(
      scene,
      Scene.given(
        listed([
          listedRecording({ id: "r1", title: "Deploy retro" }),
          listedRecording({
            id: "r2",
            state: "silent",
            startedAt: "2026-10-28T09:00:00.000Z",
            speakers: [],
          }),
        ]),
      ),
      Scene.expect(Scene.role("button", { name: /Deploy retro/ })).toExist(),
      Scene.expect(Scene.text("Thu 29 Oct, 14:05 · 1h 12m · Started by Anna")).toExist(),
      Scene.expect(Scene.text("Silent")).toExist(),
      Scene.expect(Scene.role("button", { name: /Wed 28 Oct, 11:00/ })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: /Deploy retro/ })),
      Scene.expect(Scene.text("Loading the recording…")).toExist(),
    );
  });

  it("shows older recordings from where the list ends", () => {
    Story.story(
      update,
      Story.given(listed([listedRecording()], "2026-10-29T12:05:00.000Z")),
      Story.message(Message.ClickedShowOlder()),
      Story.Command.expectExact(FetchOlder({ before: "2026-10-29T12:05:00.000Z" })),
      Story.Command.resolve(
        FetchOlder,
        Message.SucceededFetchOlder({
          page: page([listedRecording({ id: "r0", startedAt: "2026-10-20T09:00:00.000Z" })]),
        }),
      ),
      Story.model((model) => {
        expect(model.list.recordings.map(({ id }) => id)).toEqual(["r1", "r0"]);
        expect(model.list.older).toBeNull();
        expect(model.isLoadingOlder).toBe(false);
      }),
    );
  });

  it("refreshes an open recording until it's finished, and while its summary is rewritten", () => {
    const opening = update(listed(), Message.ClickedRecording({ id: "r1" })).model;

    expect(polledRecordingId(opening)).toBe("r1");
    expect(polledRecordingId(opened(recordingDetail({ state: "transcribing" })))).toBe("r1");
    expect(polledRecordingId(opened())).toBeNull();
    expect(polledRecordingId(opened(recordingDetail({ rewriting: true })))).toBe("r1");
    expect(polledRecordingId(listed())).toBeNull();
  });

  it("ignores a recording that arrives after another one was opened", () => {
    Story.story(
      update,
      Story.given(update(listed(), Message.ClickedRecording({ id: "r2" })).model),
      Story.message(
        Message.SucceededFetchRecording({ id: "r1", request: 1, recording: recordingDetail() }),
      ),
      Story.model((model) =>
        expect(Option.flatMap(model.opened, ({ recording }) => recording)).toEqual(Option.none()),
      ),
    );
  });

  it("keeps what it has and says what went wrong when a refresh fails", () => {
    Scene.scene(
      scene,
      Scene.given(
        update(
          listed(),
          Message.FailedFetchNewest({ request: 2, reason: "/api/recordings answered 503" }),
        ).model,
      ),
      Scene.expect(
        Scene.text("Couldn't load the recording history: /api/recordings answered 503"),
      ).toExist(),
      Scene.expect(Scene.role("button", { name: /Thu 29 Oct/ })).toExist(),
    );
  });

  it("keeps a late failure off the view that didn't ask for it", () => {
    Story.story(
      update,
      Story.given(opened()),
      Story.message(Message.FailedFetchNewest({ request: 2, reason: "late" })),
      Story.message(Message.FailedFetchRecording({ id: "r2", request: 2, reason: "elsewhere" })),
      Story.model((model) => expect(model.failure).toEqual(Option.none())),
    );
  });

  it("keeps an edit's answer to the recording that sent it", () => {
    const other = update(
      update(opened(), Message.ClickedBack()).model,
      Message.ClickedRecording({ id: "r2" }),
    ).model;

    Story.story(
      update,
      Story.given(other),
      Story.message(
        Message.GotRewriteMessage({
          id: "r1",
          message: SummaryRewrite.Message.CompletedRewriteSummary({
            notice: Option.some({ kind: "error", text: "For r1" }),
          }),
        }),
      ),
      Story.model((model) =>
        expect(Option.map(model.opened, ({ rewrite }) => rewrite.notice)).toEqual(
          Option.some(Option.none()),
        ),
      ),
    );
  });

  it("asks for one list page at a time, and ignores an answer older than the last", () => {
    Story.story(
      update,
      Story.given({ ...listed(), listRequests: 2 }),
      Story.message(Message.TickedListPoll()),
      Story.Command.expectNone(),
      Story.message(Message.SucceededFetchNewest({ request: 1, page: page([]) })),
      Story.model((model) => expect(model.list.recordings).toHaveLength(1)),
    );
  });

  it("goes back to the list", () => {
    Scene.scene(
      scene,
      Scene.given(opened()),
      Scene.click(Scene.role("button", { name: "← Back" })),
      Scene.expect(Scene.text("Recording history")).toExist(),
    );
  });

  it("fetches the open recording again after an edit, even once it's finished", () => {
    Story.story(
      update,
      Story.given(opened()),
      Story.message(
        Message.GotRewriteMessage({
          id: "r1",
          message: SummaryRewrite.Message.ClickedRewrite({ recordingId: "r1" }),
        }),
      ),
      Story.Command.resolve(
        SummaryRewrite.RewriteSummary,
        SummaryRewrite.Message.CompletedRewriteSummary({ notice: Option.none() }),
      ),
      Story.Command.expectExact(FetchRecording({ id: "r1", request: 1 })),
      Story.Command.resolve(
        FetchRecording,
        Message.SucceededFetchRecording({
          id: "r1",
          request: 1,
          recording: recordingDetail({ rewriting: true }),
        }),
      ),
    );
  });

  it("opens the Slack post outside the Activity, and says when it can't", () => {
    Scene.scene(
      scene,
      Scene.given(opened()),
      Scene.click(Scene.role("button", { name: "Open in Slack" })),
      Scene.Command.expectExact(OpenInSlack({ url: "https://office.slack.com/archives/C1/p12" })),
      Scene.Command.resolve(OpenInSlack, Message.FailedOpenInSlack({ reason: "Not allowed" })),
      Scene.expect(Scene.text("Couldn't load the recording history: Not allowed")).toExist(),
    );
  });
});

describe("a recording's page", () => {
  it("heads the page with the title, when it ran, who started it, how it stopped and the agenda", () => {
    Scene.scene(
      scene,
      Scene.given(
        opened(recordingDetail({ title: "Deploy retro", agenda: "What broke\nWhat next" })),
      ),
      Scene.expect(Scene.role("heading", { name: "Deploy retro" })).toExist(),
      Scene.expect(
        Scene.text("Thu 29 Oct, 14:05 · 1h 12m · Started by Anna · Stopped by Anna"),
      ).toExist(),
      Scene.expect(Scene.role("list", { name: "Who spoke" })).toExist(),
      Scene.expect(Scene.role("region", { name: "Agenda" })).toContainText("What broke"),
    );
  });

  it("shows the summary with the model and style that wrote it, and the action items", () => {
    Scene.scene(
      scene,
      Scene.given(
        opened(recordingDetail({ summaryStyle: "detailed", summaryWrittenStyle: "brief" })),
      ),
      Scene.expect(Scene.text("• Anna said hello")).toExist(),
      Scene.expect(Scene.text("✨ Brief summary by model")).toExist(),
      Scene.expect(Scene.role("button", { name: "Rewrite summary" })).toExist(),
      Scene.expect(Scene.role("checkbox", { name: "write up the deploy checklist" })).toExist(),
      Scene.expect(Scene.role("checkbox", { name: "book the room for Thursday" })).toBeChecked(),
      Scene.expect(Scene.role("combobox", { name: "Owner of ask IT about the VPN" })).toContainText(
        "Unassigned",
      ),
    );
  });

  it("shows Rewriting… until the rewrite is done, with Rewrite summary held", () => {
    Scene.scene(
      scene,
      Scene.given(opened(recordingDetail({ rewriting: true }))),
      Scene.expect(Scene.role("status", { name: "Rewriting…" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Rewriting…" })).toBeDisabled(),
    );
  });

  it("says no model wrote a summary when none could", () => {
    Scene.scene(
      scene,
      Scene.given(opened(recordingDetail({ summary: null, summaryModel: null }))),
      Scene.expect(
        Scene.text(
          "No AI model could write a summary this time. The full transcript is in the thread.",
        ),
      ).toExist(),
    );
  });

  it("groups the transcript by who spoke, and says when more is on the way", () => {
    Scene.scene(
      scene,
      Scene.given(opened(recordingDetail({ state: "transcribing", summary: null }))),
      Scene.expect(Scene.text("Hello")).toExist(),
      Scene.expect(Scene.text("Anyone there?")).toExist(),
      Scene.expect(Scene.text("14:06")).toExist(),
      Scene.expect(Scene.text("More on the way…")).toExist(),
      Scene.expect(Scene.text("Summary")).toBeAbsent(),
    );
  });

  it("edits the title and agenda behind an Edit button", () => {
    Scene.scene(
      scene,
      Scene.given(opened()),
      Scene.click(Scene.role("button", { name: "Edit" })),
      Scene.type(Scene.label("Title"), "Retro"),
      Scene.click(Scene.role("button", { name: "Save" })),
      Scene.Command.expectExact(
        RecordingEditor.SaveEdits({
          recordingId: "r1",
          changes: [{ kind: "title", title: "Retro" }],
        }),
      ),
      Scene.expect(Scene.role("button", { name: "Saving…" })).toBeDisabled(),
      Scene.Command.resolve(
        RecordingEditor.SaveEdits,
        RecordingEditor.Message.CompletedSaveEdits({ notice: Option.none() }),
      ),
      Scene.expect(Scene.role("button", { name: "Edit" })).toExist(),
      Scene.Command.resolve(
        FetchRecording,
        Message.SucceededFetchRecording({
          id: "r1",
          request: 1,
          recording: recordingDetail({ title: "Retro" }),
        }),
      ),
    );
  });
});
