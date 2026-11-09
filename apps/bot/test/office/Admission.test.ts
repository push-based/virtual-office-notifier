import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime } from "effect";

import {
  Admission,
  admit,
  Gated,
  type Gatekeeping,
  gatekeepingOf,
} from "../../src/office/Admission.ts";
import { NO_VOICE_DETAILS, type TimedVoiceStateUpdate } from "../../src/office/OfficeEvent.ts";

const OFFICE = "office";

const update = (overrides: Partial<TimedVoiceStateUpdate> = {}): TimedVoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "guild",
  oldChannelId: OFFICE,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  at: DateTime.makeUnsafe(0),
  ...overrides,
});

const join = (overrides: Partial<TimedVoiceStateUpdate> = {}) =>
  update({ oldChannelId: null, ...overrides });

const leave = (overrides: Partial<TimedVoiceStateUpdate> = {}) =>
  update({ newChannelId: null, ...overrides });

const mute = (overrides: Partial<TimedVoiceStateUpdate> = {}) =>
  update({ newDetails: { ...NO_VOICE_DETAILS, selfMute: true }, ...overrides });

interface Run {
  readonly state: Gatekeeping;
  readonly out: ReadonlyArray<Gated>;
}

const run = (inputs: ReadonlyArray<Admission>, start: Gatekeeping = gatekeepingOf(new Set())) => {
  const initial: Run = { state: start, out: [] };

  return Array.reduce(inputs, initial, ({ state, out }, input): Run => {
    const [next, gated] = admit(OFFICE)(state, input);

    return { state: next, out: [...out, ...gated] };
  });
};

const heard = (...updates: ReadonlyArray<TimedVoiceStateUpdate>) =>
  Array.map(updates, (one) => Admission.Heard({ update: one }));

const tags = (out: ReadonlyArray<Gated>) => Array.map(out, (gated) => gated._tag);

describe("admit", () => {
  it("holds someone who hasn't agreed and says they arrived", () => {
    const { state, out } = run(heard(join(), mute()));

    assert.deepStrictEqual(tags(out), ["Arrived"]);
    assert.deepStrictEqual(state.held.get("u1"), [join(), mute()]);
    assert.isFalse(state.admitted.has("u1"));
  });

  it("lets everything they did through, in order, once they agree", () => {
    const { state, out } = run([...heard(join(), mute()), Admission.Agreed({ userId: "u1" })]);

    assert.deepStrictEqual(out.slice(1), [
      Gated.Passed({ update: join() }),
      Gated.Passed({ update: mute() }),
    ]);
    assert.isTrue(state.admitted.has("u1"));
    assert.isTrue(state.inside.has("u1"));
    assert.isFalse(state.held.has("u1"));
  });

  it("drops everything they did when they refuse, and their leave after it", () => {
    const { state, out } = run([
      ...heard(join(), mute()),
      Admission.Refused({ userId: "u1" }),
      ...heard(leave()),
    ]);

    assert.deepStrictEqual(tags(out), ["Arrived"]);
    assert.isFalse(state.held.has("u1"));
    assert.isFalse(state.inside.has("u1"));
  });

  it("says they departed when they leave before answering", () => {
    const { state, out } = run(heard(join(), leave()));

    assert.deepStrictEqual(out, [
      Gated.Arrived({ userId: "u1", displayName: "Ada" }),
      Gated.Departed({ userId: "u1" }),
    ]);
    assert.isFalse(state.held.has("u1"));
  });

  it("lets someone who agreed straight back in next time", () => {
    const { out } = run([
      ...heard(join()),
      Admission.Agreed({ userId: "u1" }),
      ...heard(leave(), join()),
    ]);

    assert.deepStrictEqual(tags(out), ["Arrived", "Passed", "Passed", "Passed"]);
  });

  it("only lets the leave through once someone withdraws while inside", () => {
    const { state, out } = run(
      [Admission.Withdrawn({ userId: "u1" }), ...heard(mute(), leave(), join())],
      gatekeepingOf(new Set(["u1"])),
    );

    assert.deepStrictEqual(out, [
      Gated.Passed({ update: leave() }),
      Gated.Arrived({ userId: "u1", displayName: "Ada" }),
    ]);
    assert.isFalse(state.admitted.has("u1"));
  });

  it("ignores someone who hasn't agreed outside the office", () => {
    const { out } = run(heard(update({ oldChannelId: "lobby", newChannelId: "lobby" })));

    assert.deepStrictEqual(out, []);
  });

  it("passes bots through, since nothing downstream records them", () => {
    const { out } = run(heard(join({ isBot: true })));

    assert.deepStrictEqual(tags(out), ["Passed"]);
  });

  it("starts with whoever was already in and had agreed", () => {
    const { out } = run(heard(mute()), gatekeepingOf(new Set(["u1"])));

    assert.deepStrictEqual(tags(out), ["Passed"]);
  });
});
