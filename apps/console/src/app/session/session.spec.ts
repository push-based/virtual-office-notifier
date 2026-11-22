import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, Option, Ref } from "effect";

import { SessionToken } from "../api/api.ts";
import { fakeDiscord, fakeResources, fakeServer, fakeWorker } from "../fakes.ts";
import { Session } from "./session.ts";

const presence = { details: "In the office", state: "Not recording", timestamps: null };

describe("the session", () => {
  it.effect("signs in through Discord and keeps the Worker's session", () => {
    const worker = fakeWorker();
    const discord = fakeDiscord();

    return Effect.gen(function* () {
      yield* Session.use((session) => session.signIn);

      expect(discord.commands.authorize).toHaveBeenCalledWith({
        client_id: "client-1",
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify", "rpc.activities.write"],
      });
      expect(
        Option.map(
          Array.findFirst(worker.sent, ({ path }) => path === "/api/token"),
          ({ body }) => body,
        ),
      ).toEqual(Option.some({ code: "discord-code" }));
      expect(discord.commands.authenticate).toHaveBeenCalledWith({ access_token: "access-1" });
      expect(yield* Ref.get(yield* SessionToken)).toEqual(Option.some("session-1"));
    }).pipe(Effect.provide(fakeResources(worker.layer, discord)));
  });

  it.effect("says why the sign-in failed, whether the Worker or Discord refused", () => {
    const discord = fakeDiscord();

    discord.commands.authorize.mockRejectedValue(new Error("The user cancelled"));

    return Effect.gen(function* () {
      const refused = yield* Session.use((session) => session.signIn).pipe(
        Effect.flip,
        Effect.provide(fakeResources(fakeServer(() => ({ status: 500 })).layer, fakeDiscord())),
      );

      const cancelled = yield* Session.use((session) => session.signIn).pipe(
        Effect.flip,
        Effect.provide(fakeResources(fakeWorker().layer, discord)),
      );

      expect(refused.reason).toBe("/api/config answered 500");
      expect(cancelled.reason).toBe("The user cancelled");
    });
  });

  it.effect(
    "shows nothing in the Rich Presence before sign-in, and shrugs off Discord refusing it",
    () => {
      const discord = fakeDiscord();

      discord.commands.setActivity.mockRejectedValue(new Error("Not now"));

      return Effect.gen(function* () {
        const session = yield* Session;

        yield* session.showPresence(presence);
        expect(discord.commands.setActivity).not.toHaveBeenCalled();

        yield* session.signIn;
        yield* session.showPresence(presence);
        expect(discord.commands.setActivity).toHaveBeenCalledWith({ activity: presence });
      }).pipe(Effect.provide(fakeResources(fakeWorker().layer, discord)));
    },
  );

  it.effect("opens links outside the Activity once signed in", () => {
    const discord = fakeDiscord();

    return Effect.gen(function* () {
      const session = yield* Session;

      yield* session.signIn;
      yield* session.openExternalLink("https://office.slack.com/archives/C1/p12");

      expect(discord.commands.openExternalLink).toHaveBeenCalledWith({
        url: "https://office.slack.com/archives/C1/p12",
      });
    }).pipe(Effect.provide(fakeResources(fakeWorker().layer, discord)));
  });
});
