import type { Html, HtmlBuilder } from "foldkit/html";

export interface StatConfig {
  readonly value: string;
  readonly label: string;
}

export const stat = <Message>(h: HtmlBuilder<Message>, config: StatConfig): Html =>
  h.div(
    [h.Class("pb-stat")],
    [
      h.span([h.Class("pb-stat-value text-title text-tabular")], [config.value]),
      h.span([h.Class("pb-stat-label text-caption")], [config.label]),
    ],
  );
