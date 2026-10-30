import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { DateTime, Effect, Schema } from "effect";

import { OfficeStats, statsWindow } from "../src/OfficeStats.ts";
import type * as Wire from "../src/Wire.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("statsWindow", () => {
  it("starts the week on Monday at midnight in office time", () => {
    const now = at("2026-10-29T12:00:00Z");

    assert.deepStrictEqual(statsWindow("week", now), {
      since: at("2026-10-25T22:00:00Z"),
      until: now,
    });
  });

  it("counts late on Sunday in UTC as Monday in office time", () => {
    const now = at("2026-11-01T23:30:00Z");

    assert.deepStrictEqual(statsWindow("week", now).since, at("2026-11-01T22:00:00Z"));
  });

  it("starts the month on the first at midnight in office time", () => {
    assert.deepStrictEqual(
      statsWindow("month", at("2026-10-29T12:00:00Z")).since,
      at("2026-09-30T22:00:00Z"),
    );
    assert.deepStrictEqual(
      statsWindow("month", at("2026-10-31T22:30:00Z")).since,
      at("2026-10-31T22:00:00Z"),
    );
  });

  it("has no start for all time", () => {
    assert.isNull(statsWindow("all", at("2026-10-29T12:00:00Z")).since);
  });
});

describe("OfficeStats on the wire", () => {
  it.effect("sends the window as ISO strings", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(OfficeStats)({
        range: "week",
        since: at("2026-10-25T22:00:00Z"),
        until: at("2026-10-29T12:00:00Z"),
        timeInOffice: [],
        firstIn: [],
        lastOut: [],
        busiestHours: [],
        sounds: [],
        players: [],
        reactions: [],
        recordings: { count: 0, seconds: 0 },
      });

      assert.strictEqual(encoded.since, "2026-10-25T22:00:00.000Z");
      assert.strictEqual(encoded.until, "2026-10-29T12:00:00.000Z");
      expectTypeOf(encoded).toEqualTypeOf<Wire.OfficeStats>();
    }),
  );
});
