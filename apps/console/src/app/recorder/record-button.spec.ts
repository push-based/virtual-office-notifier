import { Array } from "effect";
import type { HtmlBuilder } from "foldkit/html";
import { click, expect, given, role, scene } from "foldkit/scene";
import { describe, it } from "vite-plus/test";

import { recordButton } from "./record-button.ts";

type Presses = ReadonlyArray<string>;

const program = (isRecording: boolean) => ({
  update: (presses: Presses, message: string) => ({ model: [...presses, message] }),
  view: (presses: Presses, h: HtmlBuilder<string>) =>
    h.div(
      [],
      [
        recordButton(h, { isRecording, isBusy: false, isDisabled: false, onPress: "pressed" }),
        h.output([], [Array.join(presses, ",")]),
      ],
    ),
});

describe("recordButton", () => {
  it("says what pressing it does", () => {
    scene(
      program(true),
      given<Presses>([]),
      click(role("button", { name: "Stop recording" })),
      expect(role("status")).toHaveText("pressed"),
    );
  });

  it("offers to start when nothing is recording", () => {
    scene(
      program(false),
      given<Presses>([]),
      expect(role("button", { name: "Start recording" })).toExist(),
    );
  });
});
