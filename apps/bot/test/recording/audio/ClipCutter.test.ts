import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Duration, Option } from "effect";

import {
  addPacket,
  type Clip,
  type Cut,
  flush,
  MAX_CLIP,
  type PartialClip,
  startClip,
} from "../../../src/recording/audio/ClipCutter.ts";

const at = DateTime.makeUnsafe("2026-10-30T12:00:00Z");

const later = (duration: Duration.Input) => DateTime.addDuration(at, duration);

const packet = (fill: number): Uint8Array => new Uint8Array([0b1111_1100, fill]);

const PACKET = Duration.millis(20);

const feed = (partial: PartialClip, fills: ReadonlyArray<number>, now = at) =>
  Array.reduce(fills, { partial, finished: Array.empty<Clip>() }, ({ partial, finished }, fill) => {
    const cut: Cut = addPacket(partial, packet(fill), PACKET, now);

    return { partial: cut.partial, finished: [...finished, ...Option.toArray(cut.finished)] };
  });

describe("ClipCutter", () => {
  it("collects packets into one clip until it's flushed", () => {
    const fed = feed(startClip("u1", at), [1, 2, 3]);

    assert.deepStrictEqual(fed.finished, []);
    assert.strictEqual(fed.partial.startedAt, at);
    assert.strictEqual(Duration.toMillis(fed.partial.duration), 60);

    assert.deepStrictEqual(
      flush(fed.partial).finished,
      Option.some({ userId: "u1", startedAt: at, packets: [packet(1), packet(2), packet(3)] }),
    );
  });

  it("cuts a clip once it reaches the longest a clip can be, and starts the next one then", () => {
    const perClip = Duration.toMillis(MAX_CLIP) / Duration.toMillis(PACKET);

    const full = feed(
      startClip("u1", at),
      Array.makeBy(perClip - 1, () => 1),
    );

    assert.deepStrictEqual(full.finished, []);

    const splitAt = later(MAX_CLIP);
    const cut = addPacket(full.partial, packet(2), PACKET, splitAt);

    assert.isTrue(Option.isSome(cut.finished));
    const clip = Option.getOrThrow(cut.finished);
    assert.strictEqual(clip.userId, "u1");
    assert.strictEqual(clip.startedAt, at);
    assert.strictEqual(clip.packets.length, perClip);
    assert.deepStrictEqual(clip.packets.at(-1), packet(2));

    assert.strictEqual(cut.partial.startedAt, splitAt);
    assert.strictEqual(Duration.toMillis(cut.partial.duration), 0);

    const next = feed(cut.partial, [3], later(Duration.sum(MAX_CLIP, PACKET)));

    assert.deepStrictEqual(
      flush(next.partial).finished,
      Option.some({ userId: "u1", startedAt: splitAt, packets: [packet(3)] }),
    );
  });

  it("finishes nothing when flushed with no packets", () => {
    const cut = flush(startClip("u1", at));

    assert.deepStrictEqual(cut.finished, Option.none());
    assert.strictEqual(cut.partial.startedAt, at);
  });

  it("finishes the partial clip when flushed, and starts empty again", () => {
    const fed = feed(startClip("u1", at), [1, 2]);
    const cut = flush(fed.partial);

    assert.deepStrictEqual(
      cut.finished,
      Option.some({ userId: "u1", startedAt: at, packets: [packet(1), packet(2)] }),
    );
    assert.deepStrictEqual(flush(cut.partial).finished, Option.none());
  });
});
