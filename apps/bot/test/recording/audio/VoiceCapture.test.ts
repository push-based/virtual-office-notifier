import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, ErrorReporter } from "effect";

import { CaptureError } from "../../../src/recording/audio/VoiceCapture.ts";
import { captureReports } from "../../fakes.ts";

describe("VoiceCapture", () => {
  it("sends how the join went along with the reason", () => {
    const error = CaptureError.make({
      reason: "Couldn't connect, stuck at signalling",
      history: ["+0ms asked Discord to join the office", "+20000ms signalling"],
    });

    assert.deepStrictEqual(error[ErrorReporter.attributes], {
      reason: "Couldn't connect, stuck at signalling",
      history: "+0ms asked Discord to join the office\n+20000ms signalling",
    });
  });

  it.effect("reports a lost voice connection as a warning with its reason", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      yield* ErrorReporter.report(
        Cause.fail(CaptureError.make({ reason: "Couldn't connect, stuck at signalling" })),
      );

      assert.deepStrictEqual(reports, [
        {
          name: "CaptureError",
          message: "Couldn't connect, stuck at signalling",
          severity: "Warn",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });
});
