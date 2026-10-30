import { describe, expect, it } from "vite-plus/test";

import { TimeLeftPipe } from "./time-left.pipe";

describe("TimeLeftPipe", () => {
  const pipe = new TimeLeftPipe();
  const until = "2026-10-27T13:00:00Z";
  const before = (ms: number) => Date.parse(until) - ms;

  it("rounds a partial minute up", () => {
    expect(pipe.transform(until, before(30_000))).toBe("1m left");
  });

  it("switches to hours from sixty minutes", () => {
    expect(pipe.transform(until, before(59 * 60_000))).toBe("59m left");
    expect(pipe.transform(until, before(61 * 60_000))).toBe("1h 1m left");
  });

  it("never goes below zero once the limit has passed", () => {
    expect(pipe.transform(until, before(-60_000))).toBe("0m left");
  });
});
