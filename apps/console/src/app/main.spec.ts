import { Array, Option } from "effect";
import { Tabs } from "design-system";
import { Scene, Story } from "foldkit";
import { describe, expect, it } from "vite-plus/test";

import * as Consent from "./consent/consent.ts";
import {
  init,
  initModel,
  isSignedIn,
  Message,
  type Model,
  SignInToDiscord,
  StartTelemetry,
  subscriptions,
  update,
  type View,
  view,
  VIEWS,
} from "./main.ts";
import * as Stats from "./stats/stats.ts";

const signedIn = (): Model => update(initModel(), Message.SucceededSignIn()).model;

const scene = { update, view };

const selectView = (value: View): Message =>
  Message.GotViewTabsMessage({
    message: Tabs.Message.SelectedTab({
      index: Option.getOrElse(
        Array.findFirstIndex(VIEWS, (tab) => tab.id === value),
        () => 0,
      ),
      value,
    }),
  });

const focusedTab = Story.Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab());

describe("the Console", () => {
  it("starts the telemetry and signs in through Discord", () => {
    expect(Array.map(init().commands ?? [], ({ name }) => name)).toEqual([
      StartTelemetry.name,
      SignInToDiscord.name,
    ]);
  });

  it("starts polling the office once signed in, and never when signing in failed", () => {
    const pollsTheOffice = (model: Model) =>
      Option.isSome(subscriptions.pollStatus.modelToDependencies(model).maybeDependencies);

    const failed = update(initModel(), Message.FailedSignIn({ reason: "No Discord" })).model;

    expect(pollsTheOffice(initModel())).toBe(false);
    expect(isSignedIn(signedIn())).toBe(true);
    expect(pollsTheOffice(signedIn())).toBe(true);
    expect(pollsTheOffice(failed)).toBe(false);
  });

  it("shows why it couldn't start when sign-in fails", () => {
    Scene.scene(
      scene,
      Scene.given(update(initModel(), Message.FailedSignIn({ reason: "No Discord" })).model),
      Scene.expect(Scene.role("heading", { name: "Couldn't start" })).toExist(),
      Scene.expect(Scene.text("No Discord")).toExist(),
    );
  });

  it("switches views with the tabs, keeping every panel in the page for its tab to point at", () => {
    Scene.scene(
      scene,
      Scene.given(initModel()),
      Scene.expect(Scene.role("tab", { name: "Now" })).toHaveAttr("aria-selected", "true"),
      Scene.click(Scene.role("tab", { name: "History" })),
      Scene.Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
      Scene.expect(Scene.role("tab", { name: "History" })).toHaveAttr("aria-selected", "true"),
      Scene.expect(Scene.role("tabpanel", { name: "History" })).toExist(),
      Scene.expect(Scene.selector("#view-panel-0")).toHaveAttr("hidden", "true"),
      Scene.expect(Scene.selector("#view-panel-2")).toHaveAttr("hidden", "true"),
      Scene.expect(Scene.selector("#view-panel-2")).toHaveText(""),
    );
  });

  it("says why on every tab when signing in through Discord failed", () => {
    Scene.scene(
      scene,
      Scene.given(
        update(initModel(), Message.FailedSignIn({ reason: "Not in an Activity" })).model,
      ),
      Scene.click(Scene.role("tab", { name: "Stats" })),
      Scene.Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
      Scene.expect(Scene.role("tabpanel", { name: "Stats" })).toContainText(
        "Couldn't sign in through Discord: Not in an Activity",
      ),
      Scene.click(Scene.role("tab", { name: "History" })),
      Scene.Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
      Scene.expect(Scene.role("tabpanel", { name: "History" })).toContainText(
        "Couldn't sign in through Discord: Not in an Activity",
      ),
    );
  });

  it("counts the stats each time the Stats tab opens, once signed in", () => {
    Story.story(
      update,
      Story.given(initModel()),
      Story.message(selectView("stats")),
      focusedTab,
      Story.Command.expectNone(),
      Story.message(Message.SucceededSignIn()),
      Story.Command.expectExact(Stats.FetchStats({ range: "week", request: 1 })),
      Story.Command.resolve(
        Stats.FetchStats,
        Stats.Message.FailedFetchStats({ request: 1, reason: "x" }),
      ),
    );
  });

  it("checks your consent each time the Privacy tab opens", () => {
    Story.story(
      update,
      Story.given(signedIn()),
      Story.message(selectView("privacy")),
      focusedTab,
      Story.Command.expectExact(Consent.FetchConsent()),
      Story.Command.resolve(
        Consent.FetchConsent,
        Consent.Message.FailedFetchConsent({ reason: "x" }),
      ),
      Story.message(selectView("now")),
      focusedTab,
      Story.message(selectView("privacy")),
      focusedTab,
      Story.Command.expectExact(Consent.FetchConsent()),
      Story.Command.resolve(
        Consent.FetchConsent,
        Consent.Message.FailedFetchConsent({ reason: "x" }),
      ),
    );
  });
});
