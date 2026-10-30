import { describe, expect, it } from "vite-plus/test";

import { changesBetween, draftOf, editNotice, planOf } from "./plan";

const untitled = { title: null, agenda: null };

describe("planOf", () => {
  it("tidies the title onto one line, trims the agenda and treats blank as none", () => {
    expect(
      planOf({ title: "  Deploy \n retro ", agenda: "\n• What broke\n• Who fixes it \n" }),
    ).toEqual({ title: "Deploy retro", agenda: "• What broke\n• Who fixes it" });
    expect(planOf({ title: "   ", agenda: "" })).toEqual(untitled);
  });

  it("round-trips through a draft", () => {
    expect(planOf(draftOf({ title: "Retro", agenda: null }))).toEqual({
      title: "Retro",
      agenda: null,
    });
  });
});

describe("changesBetween", () => {
  it("has nothing to send when nothing really changed", () => {
    expect(
      changesBetween({ title: "Retro", agenda: null }, { title: " Retro ", agenda: "  " }),
    ).toEqual([]);
  });

  it("sends one change per field that changed, the title first", () => {
    expect(changesBetween(untitled, { title: "Retro", agenda: "Friday" })).toEqual([
      { kind: "title", title: "Retro" },
      { kind: "agenda", agenda: "Friday" },
    ]);
    expect(
      changesBetween({ title: "Retro", agenda: "Friday" }, { title: "Retro", agenda: "Monday" }),
    ).toEqual([{ kind: "agenda", agenda: "Monday" }]);
  });

  it("clears a field that was emptied", () => {
    expect(changesBetween({ title: "Retro", agenda: null }, { title: "", agenda: "" })).toEqual([
      { kind: "title", title: null },
    ]);
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
