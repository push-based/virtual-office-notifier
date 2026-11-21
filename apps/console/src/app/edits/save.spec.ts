import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { REQUEST_ANSWER } from "../api/answer.ts";
import { SessionToken } from "../api/api.ts";
import { fakeServer, type SentRequest } from "../fakes.ts";
import { saveChanges } from "./save.ts";

const bot = (outcomes: Readonly<Record<string, "applied">>) => {
  let submitted = 0;

  return fakeServer((request: SentRequest) => {
    if (request.method === "POST") {
      submitted += 1;

      return { status: 202, body: { id: submitted, outcome: null } };
    }

    const id = request.path.split("/").at(-1) ?? "";

    return {
      body: {
        id: Number(id),
        ...(outcomes[id] === undefined ? { outcome: null } : { outcome: outcomes[id] }),
      },
    };
  });
};

const run = (server: ReturnType<typeof fakeServer>, seconds: number) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      saveChanges("r1", [
        { kind: "title", title: "Retro" },
        { kind: "agenda", agenda: null },
      ]),
    );

    yield* TestClock.adjust(Duration.seconds(seconds));

    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(Layer.mergeAll(server.layer, SessionToken.layer)));

describe("saving edits", () => {
  it.effect("sends one change after the other, each once the bot applied the last", () => {
    const server = bot({ "1": "applied", "2": "applied" });

    return Effect.gen(function* () {
      expect(yield* run(server, 2)).toEqual(Option.none());
      expect(server.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "POST /api/recordings/r1/edits",
        "GET /api/edits/1",
        "POST /api/recordings/r1/edits",
        "GET /api/edits/2",
      ]);
    });
  });

  it.effect("explains a change the bot ignored", () => {
    const server = fakeServer((request) =>
      request.method === "POST"
        ? { status: 202, body: { id: 1, outcome: null } }
        : {
            body: {
              id: 1,
              outcome: "ignored",
              reason: "unfinished",
              explanation: "That recording is still running.",
            },
          },
    );

    return Effect.gen(function* () {
      expect(yield* run(server, 2)).toEqual(
        Option.some({ kind: "error", text: "That recording is still running." }),
      );
    });
  });

  it.effect("stops waiting after the answer window and says the bot will catch up", () => {
    const server = bot({});

    return Effect.gen(function* () {
      expect(yield* run(server, REQUEST_ANSWER.attempts * 2)).toEqual(
        Option.some({
          kind: "error",
          text: "The bot hasn't saved that yet. It will once it's back.",
        }),
      );
      expect(server.sent.filter(({ path }) => path === "/api/edits/1")).toHaveLength(
        REQUEST_ANSWER.attempts,
      );
    });
  });
});
