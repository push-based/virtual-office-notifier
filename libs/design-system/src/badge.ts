import type { Html, HtmlBuilder } from "foldkit/html";

export type BadgeTone = "live" | "pending" | "done" | "quiet";

export const badge = <Message>(h: HtmlBuilder<Message>, tone: BadgeTone, label: string): Html =>
  h.span([h.Class(`text-caption pb-badge pb-badge-${tone}`)], [label]);
