import { afterEach, describe, expect, it } from "@effect/vitest";
import { Array, Duration, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { Runtime } from "foldkit";
import { RecordingApi, RecordingNotFound } from "office-domain/RecordingApi";
import { vi } from "vite-plus/test";

import { REQUEST_ANSWER, RequestAnswer } from "./api/answer.ts";
import { fakeResources, fakeWorker, type SentRequest } from "./dev/fake-worker.ts";
import { fakeDiscord } from "./fakes.ts";
import { init, Model, subscriptions, update, view } from "./main.ts";
import { idle, recording } from "./recorder/fixtures.ts";

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

const waitFor = (check: () => void) => Effect.promise(() => vi.waitFor(check, { timeout: 5000 }));

const sentTo = (sent: ReadonlyArray<SentRequest>, path: string) =>
  Array.findFirst(sent, (request) => request.path === path);

describe("the Console", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.effect("signs in through Discord, then shows the office and who's in it", () =>
    Effect.gen(function* () {
      const { server, discord, wrapper, handle } = started();

      yield* waitFor(() => expect(text(wrapper)).toContain("Not recording"));

      expect(text(wrapper)).toContain("In the office · 1");
      expect(discord.commands.authenticate).toHaveBeenCalledWith({ access_token: "access-1" });
      expect(
        Option.map(sentTo(server.sent, "/api/config"), ({ authorization }) => authorization),
      ).toEqual(Option.some(undefined));
      expect(
        Option.map(sentTo(server.sent, "/api/status"), ({ authorization }) => authorization),
      ).toEqual(Option.some("Bearer session-1"));
      yield* waitFor(() =>
        expect(discord.commands.setActivity).toHaveBeenCalledWith({
          activity: { details: "In the office", state: "Not recording", timestamps: null },
        }),
      );

      yield* Effect.promise(() => handle.disposeAsync());
    }),
  );

  it.effect("starts a recording with the plan and says once the bot started it", () =>
    Effect.gen(function* () {
      const { server, wrapper, handle } = started();

      yield* waitFor(() => expect(text(wrapper)).toContain("Not recording"));

      const title = wrapper.querySelector<HTMLInputElement>("#plan-title");

      if (title === null) return yield* Effect.die("The plan has no title field");

      title.value = "Deploy retro";
      title.dispatchEvent(new Event("input", { bubbles: true }));

      const start = Array.findFirst(
        wrapper.querySelectorAll("button"),
        (button) => text(button) === "Start recording",
      );

      if (Option.isSome(start)) start.value.click();

      yield* waitFor(() => expect(text(wrapper)).toContain("Recording started."));

      expect(Option.map(sentTo(server.sent, "/api/requests"), ({ body }) => body)).toEqual(
        Option.some({
          action: "start",
          title: "Deploy retro",
          agenda: null,
          summaryStyle: "brief",
        }),
      );
      yield* waitFor(() => expect(text(wrapper)).toContain("Stop recording"));

      yield* Effect.promise(() => handle.disposeAsync());
    }),
  );
});
