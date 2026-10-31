import { assert, describe, it } from "@effect/vitest";
import { DateTime } from "effect";

import {
  isOfficeHours,
  officeClock,
  startOfOfficeDay,
  startOfOfficeWeek,
} from "../src/OfficeTime.ts";

// Office time is UTC+2, so 2026-10-02T14:05+02:00 is a Friday afternoon.
const officeTime = (iso: string) => DateTime.makeUnsafe(`${iso}+02:00`);

const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

describe("isOfficeHours", () => {
  it.each([
    { at: "2026-10-02T09:00:00", expected: true, why: "the start of a Friday" },
    { at: "2026-10-02T17:59:00", expected: true, why: "just before 18:00 on a Friday" },
    { at: "2026-09-28T12:00:00", expected: true, why: "midday on a Monday" },
    { at: "2026-10-02T08:59:00", expected: false, why: "just before 09:00" },
    { at: "2026-10-02T18:00:00", expected: false, why: "18:00" },
    { at: "2026-10-03T12:00:00", expected: false, why: "a Saturday" },
    { at: "2026-10-04T12:00:00", expected: false, why: "a Sunday" },
  ])("is $expected at $why, in office time", ({ at, expected }) => {
    assert.strictEqual(isOfficeHours(officeTime(at)), expected);
  });

  it("follows office time rather than UTC", () => {
    assert.isTrue(isOfficeHours(DateTime.makeUnsafe("2026-10-02T07:00:00Z")));
    assert.isFalse(isOfficeHours(DateTime.makeUnsafe("2026-10-02T16:00:00Z")));
  });
});

describe("startOfOfficeDay and startOfOfficeWeek", () => {
  it("start at midnight office time, and the week on Monday", () => {
    const fridayNight = officeTime("2026-10-02T23:30:00");

    assert.strictEqual(fridayNight.pipe(startOfOfficeDay, iso), "2026-10-01T22:00:00.000Z");
    assert.strictEqual(fridayNight.pipe(startOfOfficeWeek, iso), "2026-09-27T22:00:00.000Z");
  });

  it("puts just after midnight office time on the new office day, though it's still yesterday in UTC", () => {
    assert.strictEqual(
      DateTime.makeUnsafe("2026-10-01T22:30:00Z").pipe(startOfOfficeDay, iso),
      "2026-10-01T22:00:00.000Z",
    );
  });
});

describe("officeClock", () => {
  it("gives the day and time in office time", () => {
    assert.strictEqual(officeClock(DateTime.makeUnsafe("2026-10-02T07:05:00Z")), "Fri 2 Oct 09:05");
  });
});
