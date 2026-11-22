import { Array, Effect, Option, Schema } from "effect";
import {
  barList,
  button,
  card,
  description,
  eyebrow,
  heatmap,
  notice,
  stat,
  Tabs,
} from "design-system";
import { AsyncData, Command, Submodel, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { ConsoleApi, reasonOf } from "../api/api.ts";
import type { Resources } from "../resources.ts";
import { OfficeStats, StatsRange } from "office-domain/OfficeStats";
import { describeStats, RANGES, type StatsView } from "./describe-stats.ts";

export const StatsData = AsyncData.Schema(OfficeStats, Schema.String);

export const Model = Schema.Struct({
  range: StatsRange,
  rangeTabs: Tabs.Model,
  stats: StatsData.schema,
  requests: Schema.Finite,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  range: "week",
  rangeTabs: Tabs.init("range"),
  stats: StatsData.Idle(),
  requests: 0,
});

export const Message = defineMessageUnion({
  GotRangeTabsMessage: { message: Tabs.Message },
  ClickedRetry: {},
  SucceededFetchStats: { request: Schema.Finite, stats: OfficeStats },
  FailedFetchStats: { request: Schema.Finite, reason: Schema.String },
});

export type Message = typeof Message.Type;

export const FetchStats = Command.define("FetchStats", {
  args: { range: StatsRange, request: Schema.Finite },
  messages: [Message.SucceededFetchStats, Message.FailedFetchStats],
  execute: ({ range, request }) =>
    ConsoleApi.use((api) => api.stats.office({ query: { range } })).pipe(
      Effect.map((stats) => Message.SucceededFetchStats({ request, stats })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchStats({ request, reason: reasonOf(failure) })),
      ),
    ),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

export const open = (model: Model): UpdateReturn => {
  const request = model.requests + 1;

  return {
    model: modifyFields(model, { stats: () => StatsData.Loading(), requests: () => request }),
    commands: [FetchStats({ range: model.range, request })],
  };
};

const RangeTabs = Tabs.create(RANGES);

const toRangeTabsMessage = (message: Tabs.Message) => Message.GotRangeTabsMessage({ message });

const selectRange = (model: Model, range: StatsRange): UpdateReturn =>
  range === model.range ? { model } : open(modifyFields(model, { range: () => range }));

const foldRangeTabsOutMessage = Tabs.OutMessage.match<
  Update.Step<Model, Message, Resources>,
  Tabs.OutMessage<StatsRange>
>({
  Selected:
    ({ value }) =>
    (stepModel) =>
      selectRange(stepModel, value),
});

const foldRangeTabs = Update.foldChild({
  update: RangeTabs.update,
  read: (model: Model) => Option.some(model.rangeTabs),
  write: (model, nextRangeTabs) => modifyFields(model, { rangeTabs: () => nextRangeTabs }),
  toParentMessage: toRangeTabsMessage,
  foldOutMessage: foldRangeTabsOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    GotRangeTabsMessage: ({ message: rangeTabsMessage }) => foldRangeTabs(model, rangeTabsMessage),

    ClickedRetry: () => open(model),

    SucceededFetchStats: ({ request, stats }) =>
      request === model.requests
        ? { model: modifyFields(model, { stats: () => StatsData.Success({ data: stats }) }) }
        : { model },

    FailedFetchStats: ({ request, reason }) =>
      request === model.requests
        ? { model: modifyFields(model, { stats: () => StatsData.Failure({ error: reason }) }) }
        : { model },
  });

const pair = <Message>(h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
  h.div([h.Class("stats-pair")], children);

const statsView = (h: HtmlBuilder<Message>, view: StatsView): ReadonlyArray<Html> => [
  pair(h, [
    stat(h, { value: view.recordings, label: "Recordings" }),
    stat(h, { value: view.recorded, label: "Recorded" }),
  ]),
  barList(h, {
    id: "time-in-office",
    label: "Time in the office",
    items: view.timeInOffice,
    empty: "Nobody was in",
  }),
  pair(h, [
    barList(h, { id: "first-in", label: "First in", items: view.firstIn, empty: "Nobody arrived" }),
    barList(h, { id: "last-out", label: "Last out", items: view.lastOut, empty: "Nobody left" }),
  ]),
  heatmap(h, {
    id: "busiest-hours",
    label: "Busiest hours · UTC+2",
    columns: view.busiest.columns,
    rows: view.busiest.rows,
    empty: "Nobody was in",
  }),
  pair(h, [
    barList(h, {
      id: "sounds",
      label: "Most played sounds",
      items: view.sounds,
      empty: "No sounds played",
    }),
    barList(h, {
      id: "players",
      label: "Who plays the most",
      items: view.players,
      empty: "No sounds played",
    }),
  ]),
  barList(h, { id: "reactions", label: "Top emoji", items: view.reactions, empty: "No emoji" }),
];

const counting = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [description(h, ["Counting…"])];

const rangeView = (
  model: Model,
  h: HtmlBuilder<Message>,
  { tablist, panel }: Tabs.Layout<StatsRange, Message>,
): Html =>
  card(h, [
    eyebrow(h, { text: "Office stats" }),
    tablist,
    ...Array.map(RANGES, ({ id }) =>
      id === model.range ? rangePanel(model, h, panel) : panel(id, [h.Class("stats-panel")], []),
    ),
  ]);

const rangePanel = (
  model: Model,
  h: HtmlBuilder<Message>,
  panel: Tabs.Layout<StatsRange, Message>["panel"],
): Html =>
  panel(
    model.range,
    [h.Class("stats-panel"), h.AriaBusy(AsyncData.isPending(model.stats))],
    AsyncData.match(model.stats, {
      onIdle: () => counting(h),
      onLoading: () => counting(h),
      onRefreshing: (stats) => statsView(h, describeStats(stats)),
      onStale: ({ data }) => statsView(h, describeStats(data)),
      onSuccess: (stats) => statsView(h, describeStats(stats)),
      onFailure: (reason) => [
        notice(h, { kind: "error", text: `Couldn't count the stats: ${reason}` }),
        button(h, {
          label: ["Try again"],
          variant: "ghost",
          onClick: Message.ClickedRetry(),
          className: "align-start",
        }),
      ],
    }),
  );

export const view = Submodel.defineView<Model, Message>((model, h) =>
  RangeTabs.view(h, {
    model: model.rangeTabs,
    label: "Range",
    appearance: "pills",
    selected: model.range,
    toParentMessage: toRangeTabsMessage,
    toView: (layout) => rangeView(model, h, layout),
  }),
);
