import { Array, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  change,
  click,
  expect,
  given,
  keydown,
  label,
  role,
  scene,
  selector,
  submit,
  text,
  type,
} from "foldkit/scene";
import { describe, expect as expectValue, it } from "vite-plus/test";

import { barList, barShare } from "./bar-list.ts";
import { blockButton, button } from "./button.ts";
import { checkbox, checkboxLabel } from "./checkbox.ts";
import { confirmBox } from "./confirm-box.ts";
import { disclosure } from "./disclosure.ts";
import { inlineSelect, selectField, textField } from "./fields.ts";
import { heatOf, heatmap } from "./heatmap.ts";
import { initials } from "./initials.ts";
import { noticeRegion } from "./notice.ts";
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

  it("sends nothing when it's clicked while disabled", () => {
    scene(
      counting((h) => button(h, { label: ["Save"], onClick: "saved", isDisabled: true })),
      given<Clicks>([]),
      expect(role("button", { name: "Save" })).not.toHaveHandler("click"),
      expect(role("status")).toHaveText(""),
    );
  });

  it("submits its form when it's a submit button", () => {
    scene(
      counting((h) => button(h, { label: ["Refuse"], isSubmit: true })),
      given<Clicks>([]),
      expect(role("button", { name: "Refuse" })).toHaveAttr("type", "submit"),
    );
  });

  it("says when it's busy", () => {
    scene(
      counting((h) => button(h, { label: ["Saving…"], onClick: "saved", isBusy: true })),
      given<Clicks>([]),
      expect(role("button", { name: "Saving…" })).toHaveAttr("aria-busy", "true"),
    );
  });
});

describe("blockButton", () => {
  it("makes a whole block one button with the page's class", () => {
    scene(
      counting((h) =>
        blockButton(h, {
          className: "row",
          onClick: "opened",
          children: [h.span([], ["Deploy retro"]), h.span([], ["Done"])],
        }),
      ),
      given<Clicks>([]),
      expect(role("button", { name: /Deploy retro/ })).toHaveClass("row"),
      expect(role("button", { name: /Deploy retro/ })).toHaveClass("pb-block-button"),
      click(role("button", { name: /Deploy retro/ })),
      expect(role("status")).toHaveText("opened"),
    );
  });
});

describe("checkbox", () => {
  const ticks = (isChecked: boolean, isDisabled = false) =>
    counting((h) =>
      h.div(
        [],
        [
          checkbox(h, {
            id: "item-4",
            isChecked,
            isDisabled,
            onToggle: (next) => (next ? "ticked" : "unticked"),
          }),
          checkboxLabel(h, { checkboxId: "item-4", text: "write up the checklist" }),
        ],
      ),
    );

  it("is a native checkbox named by its visible label", () => {
    scene(
      ticks(true),
      given<Clicks>([]),
      expect(role("checkbox", { name: "write up the checklist" })).toBeChecked(),
      expect(role("checkbox", { name: "write up the checklist" })).toHaveAttr("type", "checkbox"),
      expect(selector(".sr-only")).toBeAbsent(),
    );
  });

  it("asks for the opposite state when it's clicked", () => {
    scene(
      ticks(false),
      given<Clicks>([]),
      click(role("checkbox", { name: "write up the checklist" })),
      expect(role("status")).toHaveText("ticked"),
    );
  });

  it("can't be toggled while it's disabled", () => {
    scene(
      ticks(false, true),
      given<Clicks>([]),
      expect(role("checkbox", { name: "write up the checklist" })).toBeDisabled(),
    );
  });
});

describe("disclosure", () => {
  const plan = {
    update: (_isOpen: boolean, next: boolean) => ({ model: next }),
    view: (isOpen: boolean, h: HtmlBuilder<boolean>) =>
      disclosure(h, {
        id: "plan",
        label: "Add a title and agenda",
        isOpen,
        onToggle: (next) => next,
        children: [h.p([], ["The plan"])],
      }),
  };

  it("keeps its content in the page but hidden until it's opened", () => {
    scene(
      plan,
      given(false),
      expect(role("button", { name: "Add a title and agenda" })).toHaveAttr(
        "aria-expanded",
        "false",
      ),
      expect(selector("#plan-panel")).toHaveAttr("hidden", "true"),
      click(role("button", { name: "Add a title and agenda" })),
      expect(role("button", { name: "Add a title and agenda" })).toHaveAttr(
        "aria-expanded",
        "true",
      ),
      expect(text("The plan")).toExist(),
    );
  });

  it("opens and closes with Enter and Space", () => {
    scene(
      plan,
      given(false),
      keydown(role("button", { name: "Add a title and agenda" }), "Enter"),
      expect(selector("#plan-panel")).toHaveAttr("hidden", "false"),
      keydown(role("button", { name: "Add a title and agenda" }), " "),
      expect(selector("#plan-panel")).toHaveAttr("hidden", "true"),
    );
  });
});

describe("notice", () => {
  it("announces notices through a status region", () => {
    scene(
      counting((h) => noticeRegion(h, Option.some({ kind: "error", text: "Couldn't save" }))),
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
            { id: "1", name: "Ada Lovelace", avatarUrl: null, isSpeaking: true },
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
      counting((h) => avatar(h, { name: "Linus", avatarUrl: null })),
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

  it("reports the option that's chosen", () => {
    scene(
      form,
      given("brief"),
      change(label("Summary"), "detailed"),
      expect(role("option", { name: "Detailed" })).toHaveAttr("selected", "true"),
      expect(label("Title")).toHaveValue("detailed"),
    );
  });

  const reason = {
    update: (_value: string, next: string) => ({ model: next }),
    view: (value: string, h: HtmlBuilder<string>) =>
      textField(h, {
        id: "reason",
        label: "Why it has to be kept",
        value,
        isMultiline: true,
        rows: 4,
        maxLength: 1000,
        isRequired: true,
        isCountHidden: true,
        isLabelStrong: true,
        onInput: (next) => next,
      }),
  };

  it("can be a required textarea with its own height and no counter", () => {
    scene(
      reason,
      given(""),
      type(label("Why it has to be kept"), "A court order"),
      expect(label("Why it has to be kept")).toHaveValue("A court order"),
      expect(label("Why it has to be kept")).toHaveAttr("rows", "4"),
      expect(label("Why it has to be kept")).toHaveAttr("required", "true"),
      expect(label("Why it has to be kept")).toHaveAttr("maxLength", "1000"),
      expect(text("13/1000")).toBeAbsent(),
      expect(text("Why it has to be kept")).toHaveClass("label"),
    );
  });

  it("stops taking input while it's disabled", () => {
    scene(
      {
        update: (_value: string, next: string) => ({ model: next }),
        view: (value: string, h: HtmlBuilder<string>) =>
          textField(h, {
            id: "title",
            label: "Title",
            value,
            isDisabled: true,
            onInput: (next) => next,
          }),
      },
      given(""),
      expect(label("Title")).toBeDisabled(),
    );
  });
});

describe("inlineSelect", () => {
  it("is a select named for screen readers that reports the chosen option", () => {
    scene(
      {
        update: (_value: string, next: string) => ({ model: next }),
        view: (value: string, h: HtmlBuilder<string>) =>
          inlineSelect(h, {
            id: "owner-5",
            label: "Owner of ask IT about the VPN",
            value,
            options: [
              { value: "", label: "Unassigned" },
              { value: "u1", label: "Anna" },
            ],
            onChange: (next) => next,
          }),
      },
      given(""),
      expect(role("combobox", { name: "Owner of ask IT about the VPN" })).toContainText(
        "Unassigned",
      ),
      change(role("combobox", { name: "Owner of ask IT about the VPN" }), "u1"),
      expect(role("option", { name: "Anna" })).toHaveAttr("selected", "true"),
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

describe("confirmBox", () => {
  it("groups a confirmation under the text that asks for it", () => {
    scene(
      counting((h) =>
        confirmBox(h, {
          labelledBy: "erase-text",
          isDanger: true,
          children: [
            h.p([h.Id("erase-text")], ["This can't be undone."]),
            button(h, { label: ["Delete everything"], onClick: "erased" }),
          ],
        }),
      ),
      given<Clicks>([]),
      expect(role("group", { name: "This can't be undone." })).toHaveClass("pb-confirm-danger"),
      click(role("button", { name: "Delete everything" })),
      expect(role("status")).toHaveText("erased"),
    );
  });

  it("is a form that sends its message when it's submitted", () => {
    scene(
      counting((h) =>
        confirmBox(h, {
          onSubmit: "refused",
          children: [button(h, { label: ["Refuse"], isSubmit: true })],
        }),
      ),
      given<Clicks>([]),
      expect(selector("form.pb-confirm")).toExist(),
      submit(selector("form")),
      expect(role("status")).toHaveText("refused"),
    );
  });
});
