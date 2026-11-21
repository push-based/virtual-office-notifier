import type { Html, HtmlBuilder } from "foldkit/html";

import { eyebrow } from "./text.ts";

export interface Bar {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
}

export interface BarListConfig {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<Bar>;
  readonly empty: string;
}

export const barShare = (items: ReadonlyArray<Bar>, item: Bar): number => {
  const most = Math.max(0, ...items.map((each) => each.value));

  return most > 0 ? (item.value / most) * 100 : 0;
};

export const barList = <Message>(h: HtmlBuilder<Message>, config: BarListConfig): Html => {
  const labelId = `${config.id}-label`;

  return h.div(
    [h.Class("pb-bar-list")],
    [
      eyebrow(h, { text: config.label, tone: "muted", id: labelId }),
      config.items.length > 0
        ? h.ol(
            [h.AriaLabelledBy(labelId)],
            config.items.map((item) =>
              h.keyed("li")(
                item.id,
                [h.Class("text-body-sm")],
                [
                  h.span([h.Class("pb-bar-list-label")], [item.label]),
                  h.span([h.Class("pb-bar-list-value text-tabular")], [item.display]),
                  h.span([
                    h.Class("pb-bar-list-bar"),
                    h.AriaHidden(true),
                    h.Style({ width: `${barShare(config.items, item)}%` }),
                  ]),
                ],
              ),
            ),
          )
        : h.p([h.Class("pb-empty text-body-sm")], [config.empty]),
    ],
  );
};
