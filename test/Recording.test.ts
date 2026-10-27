import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Option, Schema } from "effect";

import {
  type ActiveRecording,
  decideRequest,
  endsAt,
  ignoredReasonText,
  isOverLimit,
  RECORDING_LIMIT,
  REQUEST_EXPIRY,
  RequestDecision,
  type RecordingRequest,
  RowId,
} from "../src/Recording.ts";

const request = (overrides: Partial<RecordingRequest> = {}): RecordingRequest => ({
  id: 1,
  requestedAt: DateTime.makeUnsafe(0),
  requestedBy: "u1",
  requestedByName: "Ada",
  action: "start",
  ...overrides,
});

const active: ActiveRecording = { id: "r1", startedAt: DateTime.makeUnsafe(0), startedBy: "u1" };

const soon = DateTime.makeUnsafe(5_000);

describe("decideRequest", () => {
  it("starts when someone in the office asks and nothing is recording", () => {
    assert.deepStrictEqual(decideRequest(request(), new Set(["u1", "u2"]), Option.none(), soon), RequestDecision.Start());
  });

  it("stops when someone in the office asks and a recording is on", () => {
    assert.deepStrictEqual(
      decideRequest(request({ action: "stop", requestedBy: "u2" }), new Set(["u1", "u2"]), Option.some(active), soon),
      RequestDecision.Stop(),
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
      decideRequest(request(), new Set(["u1"]), Option.none(), DateTime.addDuration(DateTime.makeUnsafe(0), REQUEST_EXPIRY)),
      RequestDecision.Start(),
    );
  });
});

describe("RowId", () => {
  const decode = Schema.decodeUnknownSync(RowId);

  it("reads Postgres bigint ids, which the driver returns as BigInt", () => {
    assert.strictEqual(decode(42n), 42);
    assert.strictEqual(decode("42"), 42);
    assert.strictEqual(decode(42), 42);
  });

  it("refuses anything that isn't an id", () => {
    assert.throws(() => decode("forty-two"));
    assert.throws(() => decode(null));
  });
});

describe("time limit", () => {
  it("ends four hours after the start", () => {
    assert.strictEqual(Duration.toHours(RECORDING_LIMIT), 4);
    assert.strictEqual(DateTime.toEpochMillis(endsAt(active)), 4 * 60 * 60 * 1000);
    assert.isFalse(isOverLimit(active, DateTime.makeUnsafe(4 * 60 * 60 * 1000 - 1)));
    assert.isTrue(isOverLimit(active, DateTime.makeUnsafe(4 * 60 * 60 * 1000)));
  });
});

describe("ignoredReasonText", () => {
  it("explains each reason to the person who pressed the button", () => {
    assert.include(ignoredReasonText("expired"), "again");
    assert.include(ignoredReasonText("not_in_office"), "office voice channel");
    assert.include(ignoredReasonText("already_recording"), "already");
    assert.include(ignoredReasonText("not_recording"), "no recording");
    assert.include(ignoredReasonText("office_empty"), "empty");
    assert.include(ignoredReasonText("something_else"), "couldn't");
  });
});
