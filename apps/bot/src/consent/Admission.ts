import { Array, Data } from "effect";

import { isOfficeJoin, isOfficeLeave, type TimedVoiceStateUpdate } from "../office/index.ts";

export type Admission = Data.TaggedEnum<{
  Heard: { readonly update: TimedVoiceStateUpdate };
  Agreed: { readonly userId: string };
  Refused: { readonly userId: string };
  Withdrawn: { readonly userId: string };
}>;

export const Admission = Data.taggedEnum<Admission>();

export type Decision = Exclude<Admission, { readonly _tag: "Heard" }>;

export type Gated = Data.TaggedEnum<{
  Passed: { readonly update: TimedVoiceStateUpdate };
  Arrived: { readonly userId: string; readonly displayName: string };
  Departed: { readonly userId: string };
}>;

export const Gated = Data.taggedEnum<Gated>();

export type Visit = Exclude<Gated, { readonly _tag: "Passed" }>;

export interface Gatekeeping {
  readonly admitted: ReadonlySet<string>;
  readonly inside: ReadonlySet<string>;
  readonly held: ReadonlyMap<string, ReadonlyArray<TimedVoiceStateUpdate>>;
}

export const gatekeepingOf = (admitted: ReadonlySet<string>): Gatekeeping => ({
  admitted,
  inside: admitted,
  held: new Map(),
});

type Step = readonly [Gatekeeping, ReadonlyArray<Gated>];

const added = (set: ReadonlySet<string>, userId: string): ReadonlySet<string> =>
  new Set(set).add(userId);

const removed = (set: ReadonlySet<string>, userId: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(userId);

  return next;
};

const releasing = <A>(map: ReadonlyMap<string, A>, userId: string): ReadonlyMap<string, A> => {
  const next = new Map(map);
  next.delete(userId);

  return next;
};

const holding = (
  held: Gatekeeping["held"],
  userId: string,
  updates: ReadonlyArray<TimedVoiceStateUpdate>,
): Gatekeeping["held"] => new Map(held).set(userId, updates);

const following =
  (officeChannelId: string) =>
  (inside: ReadonlySet<string>, update: TimedVoiceStateUpdate): ReadonlySet<string> => {
    if (isOfficeJoin(officeChannelId, update)) return added(inside, update.userId);

    if (isOfficeLeave(officeChannelId, update)) return removed(inside, update.userId);

    return inside;
  };

const heard = (
  officeChannelId: string,
  state: Gatekeeping,
  update: TimedVoiceStateUpdate,
): Step => {
  const { userId } = update;
  const passed = Gated.Passed({ update });

  if (update.isBot) return [state, [passed]];

  if (state.admitted.has(userId))
    return [{ ...state, inside: following(officeChannelId)(state.inside, update) }, [passed]];

  if (state.inside.has(userId))
    return isOfficeLeave(officeChannelId, update)
      ? [{ ...state, inside: removed(state.inside, userId) }, [passed]]
      : [state, []];

  const waiting = state.held.get(userId);

  if (waiting !== undefined)
    return isOfficeLeave(officeChannelId, update)
      ? [{ ...state, held: releasing(state.held, userId) }, [Gated.Departed({ userId })]]
      : [{ ...state, held: holding(state.held, userId, [...waiting, update]) }, []];

  if (isOfficeJoin(officeChannelId, update))
    return [
      { ...state, held: holding(state.held, userId, [update]) },
      [Gated.Arrived({ userId, displayName: update.displayName })],
    ];

  return [state, []];
};

const agreed = (officeChannelId: string, state: Gatekeeping, userId: string): Step => {
  const waiting = state.held.get(userId) ?? [];

  return [
    {
      admitted: added(state.admitted, userId),
      inside: Array.reduce(waiting, state.inside, following(officeChannelId)),
      held: releasing(state.held, userId),
    },
    Array.map(waiting, (update) => Gated.Passed({ update })),
  ];
};

export const admit =
  (officeChannelId: string) =>
  (state: Gatekeeping, input: Admission): Step =>
    Admission.$match(input, {
      Heard: ({ update }) => heard(officeChannelId, state, update),
      Agreed: ({ userId }) => agreed(officeChannelId, state, userId),
      Refused: ({ userId }): Step => [{ ...state, held: releasing(state.held, userId) }, []],
      Withdrawn: ({ userId }): Step => [
        {
          ...state,
          admitted: removed(state.admitted, userId),
          held: releasing(state.held, userId),
        },
        [],
      ],
    });
