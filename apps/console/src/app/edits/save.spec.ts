import { describe, expect, it } from "@effect/vitest";
import { Array, Duration, Effect, Fiber, Option, Ref } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RecordingApi } from "office-domain/RecordingApi";
import type { HandledEdit } from "office-domain/RecordingEdit";
import { TestClock } from "effect/testing";

import { REQUEST_ANSWER } from "../api/answer.ts";
import { SessionToken } from "../api/api.ts";
import { fakeApi, fakeWorker, SESSION } from "../fakes.ts";
import { saveChanges } from "./save.ts";

const RECORDING = "6a1f2c3e-4b5d-4e6f-8a7b-9c0d1e2f3a4b";

const bot = (answer: (id: number) => HandledEdit | null) => {
  let submitted = 0;

  return fakeWorker({
    edits: HttpApiBuilder.group(RecordingApi, "edits", (handlers) =>
      handlers
        .handle("submit", () =>
          Effect.sync(() => {
            submitted += 1;

            return { id: submitted, outcome: null };
          }),
        )
        .handle("find", ({ params }) =>
          Effect.succeed(answer(params.id) ?? { id: params.id, outcome: null }),
        ),
    ),
  });
};

const applied = (id: number): HandledEdit => ({ id, outcome: "applied" });

const run = (server: ReturnType<typeof fakeWorker>, seconds: number) =>
  Effect.gen(function* () {
    yield* Ref.set(yield* SessionToken, Option.some(SESSION));

    const fiber = yield* Effect.forkChild(
      saveChanges(RECORDING, [
        { kind: "title", title: "Retro" },
        { kind: "agenda", agenda: null },
      ]),
    );

    yield* TestClock.adjust(Duration.seconds(seconds));

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(fakeApi(server.layer)));

describe("saving edits", () => {
  it.effect("sends one change after the other, each once the bot applied the last", () => {
    const server = bot(applied);

    return Effect.gen(function* () {
      expect(yield* run(server, 2)).toEqual(Option.none());
      expect(Array.map(server.sent, ({ method, path }) => `${method} ${path}`)).toEqual([
        `POST /api/recordings/${RECORDING}/edits`,
        "GET /api/edits/1",
        `POST /api/recordings/${RECORDING}/edits`,
        "GET /api/edits/2",
      ]);
    });
  });

  it.effect("explains a change the bot ignored", () => {
    const server = bot((id) => ({
      id,
      outcome: "ignored",
      reason: "unfinished",
      explanation: "That recording is still running.",
    }));

    return Effect.gen(function* () {
      expect(yield* run(server, 2)).toEqual(
        Option.some({ kind: "error", text: "That recording is still running." }),
      );
    });
  });

  it.effect("stops waiting after the answer window and says the bot will catch up", () => {
    const server = bot(() => null);

    return Effect.gen(function* () {
      expect(yield* run(server, REQUEST_ANSWER.attempts * 2)).toEqual(
        Option.some({
          kind: "error",
          text: "The bot hasn't saved that yet. It will once it's back.",
        }),
      );
      expect(Array.filter(server.sent, ({ path }) => path === "/api/edits/1")).toHaveLength(
        REQUEST_ANSWER.attempts,
      );
    });
  });
});
