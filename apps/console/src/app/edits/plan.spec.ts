import { describe, expect, it } from "vite-plus/test";

import { STYLE_OPTIONS, changesBetween, draftOf, editNotice, planOf, summaryStyleOf } from "./plan";

const untitled = { title: null, agenda: null, summaryStyle: "brief" } as const;

describe("planOf", () => {
  it("tidies the title onto one line, trims the agenda and treats blank as none", () => {
    expect(
      planOf({
        title: "  Deploy \n retro ",
        agenda: "\n• What broke\n• Who fixes it \n",
        summaryStyle: "brief",
      }),
    ).toEqual({
      title: "Deploy retro",
      agenda: "• What broke\n• Who fixes it",
      summaryStyle: "brief",
    });
    expect(planOf({ title: "   ", agenda: "", summaryStyle: "brief" })).toEqual(untitled);
  });

  it("round-trips through a draft", () => {
    expect(planOf(draftOf({ title: "Retro", agenda: null, summaryStyle: "detailed" }))).toEqual({
      title: "Retro",
      agenda: null,
      summaryStyle: "detailed",
    });
  });
});

describe("changesBetween", () => {
  it("has nothing to send when nothing really changed", () => {
    expect(
      changesBetween(
        { title: "Retro", agenda: null, summaryStyle: "brief" },
        { title: " Retro ", agenda: "  ", summaryStyle: "brief" },
      ),
    ).toEqual([]);
  });

  it("sends one change per field that changed, the title first", () => {
    expect(
      changesBetween(untitled, { title: "Retro", agenda: "Friday", summaryStyle: "brief" }),
    ).toEqual([
      { kind: "title", title: "Retro" },
      { kind: "agenda", agenda: "Friday" },
    ]);
    expect(
      changesBetween(
        { title: "Retro", agenda: "Friday", summaryStyle: "brief" },
        { title: "Retro", agenda: "Monday", summaryStyle: "brief" },
      ),
    ).toEqual([{ kind: "agenda", agenda: "Monday" }]);
  });

  it("sends a change of summary style last", () => {
    expect(
      changesBetween(untitled, { title: "Retro", agenda: "", summaryStyle: "decisions" }),
    ).toEqual([
      { kind: "title", title: "Retro" },
      { kind: "summary_style", style: "decisions" },
    ]);
  });

  it("clears a field that was emptied", () => {
    expect(
      changesBetween(
        { title: "Retro", agenda: null, summaryStyle: "brief" },
        { title: "", agenda: "", summaryStyle: "brief" },
      ),
    ).toEqual([{ kind: "title", title: null }]);
  });
});

describe("the summary styles", () => {
  it("are offered by name, Brief first", () => {
    expect(STYLE_OPTIONS).toEqual([
      { value: "brief", label: "Brief" },
      { value: "detailed", label: "Detailed" },
      { value: "decisions", label: "Decisions & actions" },
    ]);
  });

  it("read back from the picker, falling back to Brief", () => {
    expect(summaryStyleOf("decisions")).toBe("decisions");
    expect(summaryStyleOf("long")).toBe("brief");
  });
});

describe("editNotice", () => {
  it("says nothing once every change is applied", () => {
    expect(editNotice([{ id: 1, outcome: "applied" }])).toBeNull();
  });

  it("explains a change the bot ignored", () => {
    expect(
      editNotice([
        { id: 1, outcome: "applied" },
        {
          id: 2,
          outcome: "ignored",
          reason: "silent",
          explanation: "Nobody spoke in that recording, so there's nothing to change.",
        },
      ]),
    ).toEqual({
      kind: "error",
      text: "Nobody spoke in that recording, so there's nothing to change.",
    });
  });

  it("says when the bot hasn't got to it yet", () => {
    expect(editNotice([{ id: 1, outcome: "applied" }, null])).toEqual({
      kind: "error",
      text: "The bot hasn't saved that yet. It will once it's back.",
    });
  });
});
