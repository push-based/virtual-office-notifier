import { describe, expect, it } from "vite-plus/test";

import { formatElapsed, formatTimeLeft } from "./duration";

describe("formatElapsed", () => {
  const since = "2026-10-27T12:00:00Z";
  const at = (seconds: number) => Date.parse(since) + seconds * 1000;

  it("shows hours, minutes and seconds", () => {
    expect(formatElapsed(since, at(3725))).toBe("01:02:05");
  });

  it("drops partial seconds", () => {
    expect(formatElapsed(since, at(59.9))).toBe("00:00:59");
  });

  it("never goes below zero when the clock is behind the server", () => {
    expect(formatElapsed(since, at(-5))).toBe("00:00:00");
  });
});

describe("formatTimeLeft", () => {
  const until = "2026-10-27T13:00:00Z";
  const before = (ms: number) => Date.parse(until) - ms;

  it("rounds a partial minute up", () => {
    expect(formatTimeLeft(until, before(30_000))).toBe("1m");
  });

  it("switches to hours from sixty minutes", () => {
    expect(formatTimeLeft(until, before(59 * 60_000))).toBe("59m");
    expect(formatTimeLeft(until, before(61 * 60_000))).toBe("1h 1m");
  });

  it("never goes below zero once the limit has passed", () => {
    expect(formatTimeLeft(until, before(-60_000))).toBe("0m");
  });
});
