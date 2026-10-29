import { describe, expect, it } from "vitest";

import { ElapsedPipe } from "./elapsed.pipe";

describe("ElapsedPipe", () => {
  const pipe = new ElapsedPipe();
  const since = "2026-10-27T12:00:00Z";
  const at = (seconds: number) => Date.parse(since) + seconds * 1000;

  it("shows hours, minutes and seconds", () => {
    expect(pipe.transform(since, at(3725))).toBe("01:02:05");
  });

  it("drops partial seconds", () => {
    expect(pipe.transform(since, at(59.9))).toBe("00:00:59");
  });

  it("never goes below zero when the clock is behind the server", () => {
    expect(pipe.transform(since, at(-5))).toBe("00:00:00");
  });
});
