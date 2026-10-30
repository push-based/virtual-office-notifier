import type { OfficeStats } from "recording-requests/wire";
import { describe, expect, it } from "vite-plus/test";

import { busiestGrid, describeStats, emojiLabel, rangeOf } from "./describe-stats";

const stats: OfficeStats = {
  range: "week",
  since: "2026-10-25T22:00:00.000Z",
  until: "2026-10-27T12:00:00.000Z",
  timeInOffice: [{ userId: "ada", name: "Ada Lovelace", seconds: 19_800, days: 2 }],
  firstIn: [{ userId: "ada", name: "Ada Lovelace", days: 1 }],
  lastOut: [{ userId: "grace", name: "Grace", days: 2 }],
  busiestHours: [],
  sounds: [{ sound: "airhorn", plays: 3 }],
  players: [{ userId: "grace", name: "Grace", plays: 3 }],
  reactions: [
    { emoji: "🎉", reactions: 2 },
    { emoji: "partyparrot", reactions: 1 },
  ],
  recordings: { count: 2, seconds: 5400 },
};

describe("describeStats", () => {
  it("turns the stats into tiles and bars", () => {
    const view = describeStats(stats);

    expect(view.recordings).toBe("2");
    expect(view.recorded).toBe("1h 30m");
    expect(view.timeInOffice).toEqual([
      { id: "ada", label: "Ada Lovelace", value: 19_800, display: "5h 30m" },
    ]);
    expect(view.firstIn).toEqual([
      { id: "ada", label: "Ada Lovelace", value: 1, display: "1 day" },
    ]);
    expect(view.lastOut).toEqual([{ id: "grace", label: "Grace", value: 2, display: "2 days" }]);
    expect(view.sounds).toEqual([{ id: "airhorn", label: "airhorn", value: 3, display: "3" }]);
    expect(view.players).toEqual([{ id: "grace", label: "Grace", value: 3, display: "3" }]);
    expect(view.reactions.map((reaction) => reaction.label)).toEqual(["🎉", ":partyparrot:"]);
  });
});

describe("emojiLabel", () => {
  it("wraps a custom emoji's name in colons and leaves real emoji alone", () => {
    expect(emojiLabel("party_parrot")).toBe(":party_parrot:");
    expect(emojiLabel("👍")).toBe("👍");
  });
});

describe("rangeOf", () => {
  it("falls back to this week for anything it doesn't know", () => {
    expect(rangeOf("month")).toBe("month");
    expect(rangeOf("year")).toBe("week");
  });
});

describe("busiestGrid", () => {
  it("shows every weekday across the hours anyone was in", () => {
    const grid = busiestGrid([
      { weekday: 1, hour: 8, people: 0 },
      { weekday: 1, hour: 9, people: 1.5 },
      { weekday: 1, hour: 10, people: 0 },
      { weekday: 1, hour: 11, people: 1 },
      { weekday: 2, hour: 9, people: 0 },
      { weekday: 2, hour: 12, people: 0 },
    ]);

    expect(grid.columns).toEqual(["9", "10", "11"]);
    expect(grid.rows.map((row) => row.label)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
    expect(grid.rows[0]?.cells).toEqual([
      { value: 1.5, description: "Mon 9:00, 1.5 people in on average" },
      { value: 0, description: "Mon 10:00, nobody in" },
      { value: 1, description: "Mon 11:00, 1 person in on average" },
    ]);
    expect(grid.rows[2]?.cells[0]).toEqual({ value: null, description: "Wed 9:00, not yet" });
  });

  it("is empty when nobody was in", () => {
    expect(busiestGrid([{ weekday: 1, hour: 9, people: 0 }])).toEqual({ columns: [], rows: [] });
  });
});
