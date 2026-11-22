import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Exit, Option, Schema } from "effect";

import {
  type ActiveRecording,
  decideRequest,
  endsAt,
  explain,
  isOverLimit,
  RECORDING_LIMIT,
  REQUEST_EXPIRY,
  RecordingStatus,
  RequestDecision,
  type RecordingRequest,
  RowId,
} from "../src/RecordingRequest.ts";
import type * as Wire from "../src/Wire.ts";

const request = (overrides: Partial<RecordingRequest> = {}): RecordingRequest => ({
  id: 1,
  requestedAt: DateTime.makeUnsafe(0),
  requestedBy: "u1",
  requestedByName: "Ada",
  action: "start",
  title: null,
  agenda: null,
  summaryStyle: null,
  ...overrides,
});

const active: ActiveRecording = {
  id: "r1",
  startedAt: DateTime.makeUnsafe(0),
  startedBy: "u1",
  pause: Option.none(),
};

const paused: ActiveRecording = {
  ...active,
  pause: Option.some({ pausedAt: DateTime.makeUnsafe(1_000), pausedBy: "u2" }),
};

const soon = DateTime.makeUnsafe(5_000);

describe("decideRequest", () => {
  it("starts when someone in the office asks and nothing is recording", () => {
    assert.deepStrictEqual(
      decideRequest(request(), new Set(["u1", "u2"]), Option.none(), soon),
      RequestDecision.Start(),
    );
  });

  it("stops the running recording when someone in the office asks", () => {
    assert.deepStrictEqual(
      decideRequest(
        request({ action: "stop", requestedBy: "u2" }),
        new Set(["u1", "u2"]),
        Option.some(active),
        soon,
      ),
      RequestDecision.Stop({ recording: active }),
    );
  });

  it("ignores a start while already recording", () => {
    assert.deepStrictEqual(
      decideRequest(request(), new Set(["u1"]), Option.some(active), soon),
      RequestDecision.Ignore({ reason: "already_recording" }),
    );
  });

  it("ignores a stop with nothing recording", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "stop" }), new Set(["u1"]), Option.none(), soon),
      RequestDecision.Ignore({ reason: "not_recording" }),
    );
  });

  it("ignores anyone who isn't in the office", () => {
    assert.deepStrictEqual(
      decideRequest(request({ requestedBy: "u9" }), new Set(["u1"]), Option.none(), soon),
      RequestDecision.Ignore({ reason: "not_in_office" }),
    );
  });

  it("pauses the running recording when anyone in the office asks", () => {
    assert.deepStrictEqual(
      decideRequest(
        request({ action: "pause", requestedBy: "u2" }),
        new Set(["u1", "u2"]),
        Option.some(active),
        soon,
      ),
      RequestDecision.Pause({ recording: active }),
    );
  });

  it("lets anyone in the office resume, not only whoever paused", () => {
    assert.deepStrictEqual(
      decideRequest(
        request({ action: "resume", requestedBy: "u1" }),
        new Set(["u1"]),
        Option.some(paused),
        soon,
      ),
      RequestDecision.Resume({ recording: paused }),
    );
  });

  it("ignores a pause while already paused, and a resume while not paused", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "pause" }), new Set(["u1"]), Option.some(paused), soon),
      RequestDecision.Ignore({ reason: "already_paused" }),
    );
    assert.deepStrictEqual(
      decideRequest(request({ action: "resume" }), new Set(["u1"]), Option.some(active), soon),
      RequestDecision.Ignore({ reason: "not_paused" }),
    );
  });

  it("ignores a pause or resume with nothing recording", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "pause" }), new Set(["u1"]), Option.none(), soon),
      RequestDecision.Ignore({ reason: "not_recording" }),
    );
    assert.deepStrictEqual(
      decideRequest(request({ action: "resume" }), new Set(["u1"]), Option.none(), soon),
      RequestDecision.Ignore({ reason: "not_recording" }),
    );
  });

  it("stops a paused recording", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "stop" }), new Set(["u1"]), Option.some(paused), soon),
      RequestDecision.Stop({ recording: paused }),
    );
  });

  it("ignores a pause from anyone who isn't in the office", () => {
    assert.deepStrictEqual(
      decideRequest(
        request({ action: "pause", requestedBy: "u9" }),
        new Set(["u1"]),
        Option.some(active),
        soon,
      ),
      RequestDecision.Ignore({ reason: "not_in_office" }),
    );
  });

  it("ignores everything while the office is empty", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "stop" }), new Set(), Option.some(active), soon),
      RequestDecision.Ignore({ reason: "office_empty" }),
    );
  });
});

describe("request expiry", () => {
  it("ignores a request the bot only sees after a minute, before anything else", () => {
    const late = DateTime.addDuration(DateTime.makeUnsafe(1), REQUEST_EXPIRY);

    assert.deepStrictEqual(
      decideRequest(request(), new Set(), Option.none(), late),
      RequestDecision.Ignore({ reason: "expired" }),
    );
    assert.deepStrictEqual(
      decideRequest(
        request(),
        new Set(["u1"]),
        Option.none(),
        DateTime.addDuration(DateTime.makeUnsafe(0), REQUEST_EXPIRY),
      ),
      RequestDecision.Start(),
    );
  });
});

describe("RowId", () => {
  const decode = Schema.decodeUnknownEffect(RowId);

  it.effect("reads Postgres bigint ids, which the driver returns as BigInt", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decode(42n), 42);
      assert.strictEqual(yield* decode("42"), 42);
      assert.strictEqual(yield* decode(42), 42);
    }),
  );

  it.effect("refuses anything that isn't an id", () =>
    Effect.gen(function* () {
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decode("forty-two"))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decode(null))));
    }),
  );
});

describe("time limit", () => {
  it("ends four hours after the start", () => {
    assert.strictEqual(Duration.toHours(RECORDING_LIMIT), 4);
    assert.strictEqual(DateTime.toEpochMillis(endsAt(active.startedAt)), 4 * 60 * 60 * 1000);
    assert.isFalse(isOverLimit(active, DateTime.makeUnsafe(4 * 60 * 60 * 1000 - 1)));
    assert.isTrue(isOverLimit(active, DateTime.makeUnsafe(4 * 60 * 60 * 1000)));
  });

  it("counts pauses, so a paused recording still ends four hours after the start", () => {
    assert.isTrue(isOverLimit(paused, DateTime.makeUnsafe(4 * 60 * 60 * 1000)));
  });
});

describe("explain", () => {
  it("explains each ignore reason to the person who pressed the button", () => {
    assert.include(explain("expired"), "again");
    assert.include(explain("not_in_office"), "office voice channel");
    assert.include(explain("already_recording"), "already");
    assert.include(explain("not_recording"), "no recording");
    assert.include(explain("office_empty"), "empty");
    assert.include(explain("already_paused"), "already paused");
    assert.include(explain("not_paused"), "isn't paused");
  });
});

describe("the page's types", () => {
  it("see times as the ISO strings the Worker sends", () => {
    expectTypeOf<Wire.RecordingStatus["updatedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<Wire.RunningRecording["startedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<Wire.RunningRecording["endsAt"]>().toEqualTypeOf<string>();
    expectTypeOf<Wire.RecordingPause["since"]>().toEqualTypeOf<string>();
  });

  it.effect("send times as ISO strings", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(RecordingStatus)({
        botInOffice: true,
        occupants: [],
        recording: {
          id: "r1",
          startedAt: DateTime.makeUnsafe(0),
          startedByName: "Ada",
          endsAt: endsAt(active.startedAt),
          pause: { since: DateTime.makeUnsafe(60_000), byName: "Ben" },
          title: "Deploy retro",
          agenda: null,
          summaryStyle: "detailed",
        },
        updatedAt: DateTime.makeUnsafe(0),
      });

      assert.strictEqual(encoded.recording?.endsAt, "1970-01-01T04:00:00.000Z");
      assert.deepStrictEqual(encoded.recording?.pause, {
        since: "1970-01-01T00:01:00.000Z",
        byName: "Ben",
      });
      assert.strictEqual(encoded.updatedAt, "1970-01-01T00:00:00.000Z");
      assert.strictEqual(encoded.recording?.title, "Deploy retro");
    }),
  );
});
