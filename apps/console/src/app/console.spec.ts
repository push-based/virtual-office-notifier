import { DateTime, Duration, Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Runtime } from "foldkit";
import { RecordingApi, RecordingNotFound } from "office-domain/RecordingApi";
import type { RecordingStatus } from "office-domain/RecordingRequest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { REQUEST_ANSWER, RequestAnswer } from "./api/answer.ts";
import { fakeDiscord, fakeResources, fakeWorker } from "./fakes.ts";
import { init, Model, subscriptions, update, view } from "./main.ts";

const idle: RecordingStatus = {
  botInOffice: true,
  occupants: [{ userId: "u1", displayName: "Ada", avatarUrl: null, speaking: true }],
  recording: null,
  updatedAt: DateTime.makeUnsafe("2026-10-27T12:00:00Z"),
};

const recording: RecordingStatus = {
  ...idle,
  recording: {
    id: "r1",
    startedAt: DateTime.makeUnsafe("2026-10-27T12:00:00Z"),
    startedByName: "Ada",
    endsAt: DateTime.makeUnsafe("2026-10-27T16:00:00Z"),
    pause: null,
    title: "Deploy retro",
    agenda: null,
    summaryStyle: "brief",
  },
};

const office = () => {
  let status = idle;

  return fakeWorker({
    recording: HttpApiBuilder.group(RecordingApi, "recording", (handlers) =>
      handlers
        .handle("status", () => Effect.sync(() => status))
        .handle("submit", () =>
          Effect.sync(() => {
            status = recording;

            return { id: 7, outcome: null };
          }),
        )
        .handle("find", ({ params }) => Effect.succeed({ id: params.id, outcome: "started" })),
    ),
    history: HttpApiBuilder.group(RecordingApi, "history", (handlers) =>
      handlers
        .handle("recordings", () => Effect.succeed({ recordings: [], older: null }))
        .handle("recording", () => Effect.fail(RecordingNotFound.make())),
    ),
  });
};

const quickAnswers = Layer.succeed(RequestAnswer, {
  every: Duration.millis(10),
  attempts: REQUEST_ANSWER.attempts,
});

const started = () => {
  const server = office();
  const discord = fakeDiscord();
  const container = document.createElement("div");
  const wrapper = document.createElement("div");

  container.id = "console";

  wrapper.append(container);
  document.body.append(wrapper);

  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      init,
      update,
      view: (model, h) => view(model, h).body,
      subscriptions,
      resources: fakeResources(server.layer, discord).pipe(Layer.provideMerge(quickAnswers)),
      container,
    }),
  );

  return { server, discord, wrapper, handle };
};

const text = (element: HTMLElement) => element.textContent ?? "";

describe("the Console", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("signs in through Discord, then shows the office and who's in it", async () => {
    const { server, discord, wrapper, handle } = started();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Not recording"));

    expect(text(wrapper)).toContain("In the office · 1");
    expect(discord.commands.authenticate).toHaveBeenCalledWith({ access_token: "access-1" });
    expect(server.sent.find(({ path }) => path === "/api/config")?.authorization).toBeUndefined();
    expect(server.sent.find(({ path }) => path === "/api/status")?.authorization).toBe(
      "Bearer session-1",
    );
    await vi.waitFor(() =>
      expect(discord.commands.setActivity).toHaveBeenCalledWith({
        activity: { details: "In the office", state: "Not recording", timestamps: null },
      }),
    );

    await handle.disposeAsync();
  });

  it("starts a recording with the plan and says once the bot started it", async () => {
    const { server, wrapper, handle } = started();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Not recording"));

    const title = wrapper.querySelector<HTMLInputElement>("#plan-title");

    if (title === null) throw new Error("The plan has no title field");

    title.value = "Deploy retro";
    title.dispatchEvent(new Event("input", { bubbles: true }));

    const start = [...wrapper.querySelectorAll("button")].find(
      (button) => text(button) === "Start recording",
    );

    start?.click();

    await vi.waitFor(() => expect(text(wrapper)).toContain("Recording started."));

    expect(server.sent.find(({ path }) => path === "/api/requests")?.body).toEqual({
      action: "start",
      title: "Deploy retro",
      agenda: null,
      summaryStyle: "brief",
    });
    await vi.waitFor(() => expect(text(wrapper)).toContain("Stop recording"));

    await handle.disposeAsync();
  });
});
