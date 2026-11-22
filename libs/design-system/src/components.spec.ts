import { Array } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { click, expect, given, label, role, scene, selector, text, type } from "foldkit/scene";
import { describe, expect as expectValue, it } from "vite-plus/test";

import { barList, barShare } from "./bar-list.ts";
import { button, recordButton } from "./button.ts";
import { selectField, textField } from "./fields.ts";
import { heatOf, heatmap } from "./heatmap.ts";
import { initials } from "./initials.ts";
import { notice, noticeRegion } from "./notice.ts";
import { avatar, people } from "./people.ts";
import { statusHeading } from "./status-heading.ts";

type Clicks = ReadonlyArray<string>;

const counting = (render: (h: HtmlBuilder<string>) => Html) => ({
  update: (clicks: Clicks, message: string) => ({ model: [...clicks, message] }),
  view: (clicks: Clicks, h: HtmlBuilder<string>) =>
    h.div([], [render(h), h.output([], [Array.join(clicks, ",")])]),
});

describe("button", () => {
  it("sends its message when clicked", () => {
    scene(
      counting((h) => button(h, { label: ["Save"], onClick: "saved" })),
      given<Clicks>([]),
      click(role("button", { name: "Save" })),
      expect(role("status")).toHaveText("saved"),
    );
  });

  it("is marked disabled without losing focus", () => {
    scene(
      counting((h) => button(h, { label: ["Save"], onClick: "saved", isDisabled: true })),
      given<Clicks>([]),
      expect(role("button", { name: "Save" })).toHaveAttr("aria-disabled", "true"),
      expect(role("button", { name: "Save" })).toBeDisabled(),
    );
  });

  it("says what pressing the record button does", () => {
    scene(
      counting((h) =>
        recordButton(h, {
          isRecording: true,
          isBusy: false,
          isDisabled: false,
          onPress: "pressed",
        }),
      ),
      given<Clicks>([]),
      click(role("button", { name: "Stop recording" })),
      expect(role("status")).toHaveText("pressed"),
    );
  });
});

describe("notice", () => {
  it("announces notices through a status region", () => {
    scene(
      counting((h) => noticeRegion(h, [notice(h, { kind: "error", text: "Couldn't save" })])),
      given<Clicks>([]),
      expect(selector(".pb-notice-region")).toHaveAttr("role", "status"),
      expect(text("Couldn't save")).toHaveClass("pb-notice-error"),
    );
  });
});

describe("people", () => {
  it("labels the group and shows initials when there's no picture", () => {
    scene(
      counting((h) =>
        people(h, {
          id: "office",
          label: "In the office · 2",
          people: [
            { id: "1", name: "Ada Lovelace", avatarUrl: null, speaking: true },
            { id: "2", name: "Ben", avatarUrl: "https://cdn.example/ben.png" },
          ],
        }),
      ),
      given<Clicks>([]),
      expect(role("list", { name: "In the office · 2" })).toExist(),
      expect(role("img", { name: "Ada Lovelace" })).toHaveText("AL"),
      expect(role("img", { name: "Ben" })).toHaveAttr("src", "https://cdn.example/ben.png"),
      expect(selector("[title='Ada Lovelace']")).toHaveClass("pb-avatar-speaking"),
    );
  });

  it("takes the first letter of the first two names", () => {
    expectValue(initials("ada king lovelace")).toBe("AK");
    expectValue(initials("Linus")).toBe("L");
  });

  it("names a lone avatar", () => {
    scene(
      counting((h) => avatar(h, { name: "Linus", src: null })),
      given<Clicks>([]),
      expect(role("img", { name: "Linus" })).toHaveText("L"),
    );
  });
});

describe("barList", () => {
  const items = [
    { id: "a", label: "Ada", value: 30, display: "30m" },
    { id: "b", label: "Ben", value: 15, display: "15m" },
  ];

  it("sizes each bar against the largest value", () => {
    expectValue(Array.map(items, (item) => barShare(items, item))).toEqual([100, 50]);
  });

  it("lists the bars under their label, or says when there are none", () => {
    scene(
      counting((h) =>
        h.div(
          [],
          [
            barList(h, { id: "time", label: "Time in the office", items, empty: "Nobody" }),
            barList(h, { id: "sounds", label: "Sounds", items: [], empty: "No sounds played" }),
          ],
        ),
      ),
      given<Clicks>([]),
      expect(role("list", { name: "Time in the office" })).toContainText("Ada30m"),
      expect(text("No sounds played")).toExist(),
    );
  });
});

describe("heatmap", () => {
  const rows = [
    {
      label: "Mon",
      cells: [
        { value: 4, description: "Mon 9:00, 4 people" },
        { value: null, description: "Mon 10:00, not yet" },
      ],
    },
    { label: "Tue", cells: [{ value: 2, description: "Tue 9:00, 2 people" }] },
  ];

  it("shades each cell against the busiest one", () => {
    expectValue(
      Array.flatMap(rows, (row) => Array.map(row.cells, (cell) => heatOf(rows, cell))),
    ).toEqual([1, 0, 0.5]);
  });

  it("describes every cell for screen readers and marks unknown ones", () => {
    scene(
      counting((h) =>
        heatmap(h, { id: "busy", label: "Busiest hours", columns: ["9", "10"], rows, empty: "-" }),
      ),
      given<Clicks>([]),
      expect(role("table", { name: "Busiest hours" })).toExist(),
      expect(selector("td[title='Mon 10:00, not yet']")).toHaveClass("pb-heatmap-unknown"),
      expect(text("Tue 9:00, 2 people")).toExist(),
    );
  });
});

describe("fields", () => {
  const form = {
    update: (_value: string, next: string) => ({ model: next }),
    view: (value: string, h: HtmlBuilder<string>) =>
      h.div(
        [],
        [
          textField(h, {
            id: "title",
            label: "Title",
            value,
            maxLength: 80,
            onInput: (next) => next,
          }),
          selectField(h, {
            id: "style",
            label: "Summary",
            value,
            options: [
              { value: "brief", label: "Brief" },
              { value: "detailed", label: "Detailed" },
            ],
            onChange: (next) => next,
          }),
        ],
      ),
  };

  it("counts the characters against the limit as you type", () => {
    scene(
      form,
      given(""),
      type(label("Title"), "Retro"),
      expect(label("Title")).toHaveValue("Retro"),
      expect(text("5/80")).toExist(),
    );
  });

  it("selects the current option", () => {
    scene(
      form,
      given("detailed"),
      expect(role("option", { name: "Detailed" })).toHaveAttr("selected", "true"),
    );
  });
});

describe("statusHeading", () => {
  it("shows the live dot, the subheading and the description at the asked level", () => {
    scene(
      counting((h) =>
        statusHeading(h, {
          heading: "Recording · 00:12:34",
          subheading: "Deploy retro",
          description: "Started by Chris",
          isLive: true,
          level: 2,
        }),
      ),
      given<Clicks>([]),
      expect(role("heading", { name: "Recording · 00:12:34", level: 2 })).toExist(),
      expect(selector(".pb-live-dot")).toExist(),
      expect(text("Deploy retro")).toExist(),
      expect(text("Started by Chris")).toExist(),
    );
  });
});
