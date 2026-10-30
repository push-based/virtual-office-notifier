import { describe, expect, it } from "vite-plus/test";

import {
  canOpen,
  describeStop,
  formatClock,
  formatOfficeTime,
  formatRunTime,
  isLive,
  stateBadge,
  transcriptTurns,
} from "./describe-recording";
import { anna, ben, recordingDetail } from "./fixtures";

describe("formatOfficeTime", () => {
  it("shows when a recording started in office time, UTC+2", () => {
    expect(formatOfficeTime("2026-10-29T12:05:00.000Z")).toBe("Thu 29 Oct, 14:05");
    expect(formatOfficeTime("2026-10-31T22:30:00.000Z")).toBe("Sun 1 Nov, 00:30");
    expect(formatClock("2026-10-29T07:09:00.000Z")).toBe("09:09");
  });
});

describe("formatRunTime", () => {
  it("says how long a recording ran, in hours and minutes", () => {
    expect(formatRunTime("2026-10-29T12:05:00Z", "2026-10-29T13:17:30Z", 0)).toBe("1h 12m");
    expect(formatRunTime("2026-10-29T12:05:00Z", "2026-10-29T12:47:00Z", 0)).toBe("42m");
    expect(formatRunTime("2026-10-29T12:05:00Z", "2026-10-29T12:05:20Z", 0)).toBe("under a minute");
  });

  it("counts a running recording up to now", () => {
    expect(formatRunTime("2026-10-29T12:05:00Z", null, Date.parse("2026-10-29T14:05:00Z"))).toBe(
      "2h 0m",
    );
  });
});

describe("recording states", () => {
  it("gives each state its badge", () => {
    expect(stateBadge("running")).toEqual({ label: "Running", tone: "live" });
    expect(stateBadge("transcribing")).toEqual({ label: "Transcribing", tone: "pending" });
    expect(stateBadge("finished")).toEqual({ label: "Finished", tone: "done" });
    expect(stateBadge("silent")).toEqual({ label: "Silent", tone: "quiet" });
  });

  it("opens every recording but a silent one", () => {
    expect(canOpen("running")).toBe(true);
    expect(canOpen("transcribing")).toBe(true);
    expect(canOpen("finished")).toBe(true);
    expect(canOpen("silent")).toBe(false);
  });

  it("keeps refreshing only while there's more on the way", () => {
    expect(isLive("running")).toBe(true);
    expect(isLive("transcribing")).toBe(true);
    expect(isLive("finished")).toBe(false);
    expect(isLive("silent")).toBe(false);
  });
});

describe("describeStop", () => {
  it("says how a recording stopped", () => {
    expect(describeStop(recordingDetail())).toBe("Stopped by Anna");
    expect(describeStop(recordingDetail({ stoppedBy: null }))).toBe("Stopped");
    expect(describeStop(recordingDetail({ stopReason: "office_emptied" }))).toBe("Office emptied");
    expect(describeStop(recordingDetail({ stopReason: "time_limit" }))).toBe(
      "Hit the 4-hour limit",
    );
    expect(describeStop(recordingDetail({ stopReason: "bot_restarted" }))).toBe("Bot restarted");
    expect(describeStop(recordingDetail({ stopReason: null }))).toBeNull();
  });
});

describe("transcriptTurns", () => {
  it("groups back-to-back clips from the same person", () => {
    expect(transcriptTurns(recordingDetail().clips)).toEqual([
      { speaker: anna, startedAt: "2026-10-29T12:06:00.000Z", lines: ["Hello", "Anyone there?"] },
      { speaker: ben, startedAt: "2026-10-29T12:07:00.000Z", lines: ["Morning"] },
    ]);
  });

  it("starts a new turn when someone speaks again after someone else", () => {
    const clips = [
      { speaker: anna, startedAt: "2026-10-29T12:06:00.000Z", text: "One" },
      { speaker: ben, startedAt: "2026-10-29T12:07:00.000Z", text: "Two" },
      { speaker: anna, startedAt: "2026-10-29T12:08:00.000Z", text: "Three" },
    ];

    expect(transcriptTurns(clips).map((turn) => turn.lines)).toEqual([["One"], ["Two"], ["Three"]]);
  });
});
