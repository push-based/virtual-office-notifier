import type { Html, HtmlBuilder } from "foldkit/html";

import { eyebrow } from "./text.ts";

export interface HeatmapCell {
  readonly value: number | null;
  readonly description: string;
}

export interface HeatmapRow {
  readonly label: string;
  readonly cells: ReadonlyArray<HeatmapCell>;
}

export interface HeatmapConfig {
  readonly id: string;
  readonly label: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<HeatmapRow>;
  readonly empty: string;
}

export const heatOf = (rows: ReadonlyArray<HeatmapRow>, cell: HeatmapCell): number => {
  const hottest = Math.max(0, ...rows.flatMap((row) => row.cells.map((each) => each.value ?? 0)));

  return hottest > 0 && cell.value !== null ? cell.value / hottest : 0;
};

export const heatmap = <Message>(h: HtmlBuilder<Message>, config: HeatmapConfig): Html => {
  const captionId = `${config.id}-caption`;

  return h.div(
    [h.Class("pb-heatmap")],
    [
      eyebrow(h, { text: config.label, tone: "muted", id: captionId }),
      config.rows.length > 0 && config.columns.length > 0
        ? h.div(
            [h.Class("pb-heatmap-scroller")],
            [
              h.table(
                [h.AriaLabelledBy(captionId), h.Class("text-caption")],
                [
                  h.thead(
                    [],
                    [
                      h.tr(
                        [],
                        [
                          h.td([]),
                          ...config.columns.map((column) => h.th([h.Scope("col")], [column])),
                        ],
                      ),
                    ],
                  ),
                  h.tbody(
                    [],
                    config.rows.map((row) =>
                      h.keyed("tr")(
                        row.label,
                        [],
                        [
                          h.th([h.Scope("row")], [row.label]),
                          ...row.cells.map((cell) =>
                            h.td(
                              [
                                ...(cell.value === null ? [h.Class("pb-heatmap-unknown")] : []),
                                h.Style({ "--heat": String(heatOf(config.rows, cell)) }),
                                h.Title(cell.description),
                              ],
                              [h.span([h.Class("sr-only")], [cell.description])],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          )
        : h.p([h.Class("pb-empty text-body-sm")], [config.empty]),
    ],
  );
};
