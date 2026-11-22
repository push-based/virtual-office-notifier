import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ConsoleApi } from "../api/api.ts";
import { Session } from "../session/session.ts";
import { fakeOfficeResources, scenarioOf } from "./fake-office.ts";

const signedIn = Session.use((session) => session.signIn);

describe("the fake office for vp dev --mode fake", () => {
  it("picks the scenario from the page's query, and falls back to an idle office", () => {
    expect(scenarioOf("?scenario=recording")).toBe("recording");
    expect(scenarioOf("?scenario=nonsense")).toBe("idle");
    expect(scenarioOf("")).toBe("idle");
  });

  it.live("signs in and answers each scenario through the real contract", () =>
    Effect.gen(function* () {
      const recording = yield* Effect.gen(function* () {
        yield* signedIn;

        return yield* ConsoleApi.use((api) => api.recording.status());
      }).pipe(Effect.provide(fakeOfficeResources("recording")));

      const away = yield* Effect.gen(function* () {
        yield* signedIn;

        return yield* ConsoleApi.use((api) => api.recording.status());
      }).pipe(Effect.provide(fakeOfficeResources("away")));

      expect(recording.recording?.title).toBe("Deploy retro");
      expect(away.botInOffice).toBe(false);
    }),
  );

  it.live("starts a recording when asked, and says so once the bot has", () =>
    Effect.gen(function* () {
      yield* signedIn;

      const api = yield* ConsoleApi;

      const { id } = yield* api.recording.submit({
        payload: { action: "start", title: "Standup", agenda: null, summaryStyle: "brief" },
      });

      expect(yield* api.recording.find({ params: { id } })).toEqual({ id, outcome: "started" });
      expect((yield* api.recording.status()).recording?.title).toBe("Standup");
    }).pipe(Effect.provide(fakeOfficeResources("idle"))),
  );
});
