import { Effect, Option, Schema } from "effect";
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
import { describeStats, RANGES, rangeOf, type StatsView } from "./describe-stats.ts";

export const StatsData = AsyncData.Schema(OfficeStats, Schema.String);

export const Model = Schema.Struct({
  range: StatsRange,
  rangeTabs: Tabs.Model,
  stats: StatsData.schema,
});

export type Model = typeof Model.Type;

export const init = (): Model => ({
  range: "week",
  rangeTabs: Tabs.init("range"),
  stats: StatsData.Idle(),
});

export const Message = defineMessageUnion({
  GotRangeTabsMessage: { message: Tabs.Message },
  ClickedRetry: {},
  SucceededFetchStats: { range: StatsRange, stats: OfficeStats },
  FailedFetchStats: { range: StatsRange, reason: Schema.String },
});

export type Message = typeof Message.Type;

export const FetchStats = Command.define("FetchStats", {
  args: { range: StatsRange },
  messages: [Message.SucceededFetchStats, Message.FailedFetchStats],
  interrupt: true,
  execute: ({ range }) =>
    ConsoleApi.use((api) => api.stats.office({ query: { range } })).pipe(
      Effect.map((stats) => Message.SucceededFetchStats({ range, stats })),
      Effect.catch((failure) =>
        Effect.succeed(Message.FailedFetchStats({ range, reason: reasonOf(failure) })),
      ),
    ),
});

type UpdateReturn = Update.Return<Model, Message, Resources>;

export const open = (model: Model): UpdateReturn => ({
  model: modifyFields(model, { stats: () => StatsData.Loading() }),
  commands: [FetchStats({ range: model.range })],
});

const toRangeTabsMessage = (message: Tabs.Message) => Message.GotRangeTabsMessage({ message });

const selectRange = (model: Model, range: StatsRange): UpdateReturn =>
  range === model.range ? { model } : open(modifyFields(model, { range: () => range }));

const foldRangeTabsOutMessage = Tabs.OutMessage.match<Update.Step<Model, Message, Resources>>({
  Selected:
    ({ value }) =>
    (stepModel) =>
      selectRange(stepModel, rangeOf(value)),
});

const foldRangeTabs = Update.foldChild({
  update: Tabs.update,
  read: (model: Model) => Option.some(model.rangeTabs),
  write: (model, nextRangeTabs) => modifyFields(model, { rangeTabs: () => nextRangeTabs }),
  toParentMessage: toRangeTabsMessage,
  foldOutMessage: foldRangeTabsOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    GotRangeTabsMessage: ({ message: rangeTabsMessage }) => foldRangeTabs(model, rangeTabsMessage),

    ClickedRetry: () => open(model),

    SucceededFetchStats: ({ range, stats }) =>
      range === model.range
        ? { model: modifyFields(model, { stats: () => StatsData.Success({ data: stats }) }) }
        : { model },

    FailedFetchStats: ({ range, reason }) =>
      range === model.range
        ? { model: modifyFields(model, { stats: () => StatsData.Failure({ error: reason }) }) }
        : { model },
  });

const pair = <Message>(h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
  h.div([h.Class("stats-pair")], children);

const statsView = (h: HtmlBuilder<Message>, view: StatsView): ReadonlyArray<Html> => [
  pair(h, [stat(h, view.recordings, "Recordings"), stat(h, view.recorded, "Recorded")]),
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
  card(h, "lg", [
    eyebrow(h, { text: "Office stats" }),
    tablist,
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
    ),
  ]);

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Tabs.view(h, {
    slotId: "range-tabs",
    model: model.rangeTabs,
    label: "Range",
    appearance: "pills",
    tabs: RANGES,
    selected: model.range,
    toParentMessage: toRangeTabsMessage,
    toView: (layout) => rangeView(model, h, layout),
  }),
);
