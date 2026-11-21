import { identity } from "effect";
import { Scene, Story } from "foldkit";
import type { HtmlBuilder } from "foldkit/html";
import { describe, expect, it } from "vite-plus/test";

import type { OfficeStats } from "../wire.ts";
import { FetchStats, init, Message, type Model, open, StatsData, update, view } from "./stats.ts";

const stats: OfficeStats = {
  range: "week",
  since: "2026-10-25T22:00:00.000Z",
  until: "2026-10-27T12:00:00.000Z",
  timeInOffice: [{ userId: "u1", name: "Ada", seconds: 7200, days: 2 }],
  firstIn: [{ userId: "u1", name: "Ada", days: 2 }],
  lastOut: [],
  busiestHours: [{ weekday: 1, hour: 9, people: 2 }],
  sounds: [{ sound: "airhorn", plays: 4 }],
  players: [{ userId: "u1", name: "Ada", plays: 4 }],
  reactions: [{ emoji: "tada", reactions: 2 }],
  recordings: { count: 3, seconds: 5400 },
};

const scene = {
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    h.submodel({ slotId: "stats", model, view, toParentMessage: identity }),
};

describe("the office stats", () => {
  it("loads this week's stats once it's opened, and shows them", () => {
    Story.story(
      update,
      Story.given(open(init()).model),
      Story.model((model) => expect(model.stats).toEqual(StatsData.Loading())),
    );
    expect(open(init()).commands?.map(({ name, args }) => ({ name, args }))).toEqual([
      { name: FetchStats.name, args: { range: "week" } },
    ]);
    Scene.scene(
      scene,
      Scene.given({ ...init(), stats: StatsData.Success({ data: stats }) }),
      Scene.expect(Scene.role("tab", { name: "This week" })).toHaveAttr("aria-selected", "true"),
      Scene.expect(Scene.role("tabpanel")).toHaveId("range-panel-week"),
      Scene.expect(Scene.text("Recordings")).toExist(),
      Scene.expect(Scene.text("1h 30m")).toExist(),
      Scene.expect(Scene.role("list", { name: "Top emoji" })).toContainText(":tada:"),
      Scene.expect(Scene.text("Nobody left")).toExist(),
    );
  });

  it("loads the range that's picked, and ignores an answer for another one", () => {
    Scene.scene(
      scene,
      Scene.given({ ...init(), stats: StatsData.Success({ data: stats }) }),
      Scene.click(Scene.role("tab", { name: "All time" })),
      Scene.expect(Scene.text("Counting…")).toExist(),
      Scene.Command.expectExact(FetchStats({ range: "all" })),
      Scene.Command.resolve(FetchStats, Message.SucceededFetchStats({ range: "week", stats })),
      Scene.expect(Scene.text("Counting…")).toExist(),
    );
  });

  it("says why when the stats can't be counted, and counts again when asked", () => {
    Scene.scene(
      scene,
      Scene.given({ ...init(), stats: StatsData.Failure({ error: "/api/stats answered 503" }) }),
      Scene.expect(Scene.text("Couldn't count the stats: /api/stats answered 503")).toExist(),
      Scene.click(Scene.role("button", { name: "Try again" })),
      Scene.Command.expectExact(FetchStats({ range: "week" })),
      Scene.Command.resolve(FetchStats, Message.SucceededFetchStats({ range: "week", stats })),
      Scene.expect(Scene.text("Recordings")).toExist(),
    );
  });
});
