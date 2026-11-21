import type { Html, HtmlBuilder } from "foldkit/html";

export const stat = <Message>(h: HtmlBuilder<Message>, value: string, label: string): Html =>
  h.div(
    [h.Class("pb-stat")],
    [
      h.span([h.Class("pb-stat-value text-title text-tabular")], [value]),
      h.span([h.Class("pb-stat-label text-caption")], [label]),
    ],
  );
