import type { Html, HtmlBuilder } from "foldkit/html";

export type BadgeTone = "live" | "pending" | "done" | "quiet";

export interface BadgeConfig {
  readonly tone: BadgeTone;
  readonly label: string;
}

export const badge = <Message>(h: HtmlBuilder<Message>, config: BadgeConfig): Html =>
  h.span([h.Class(`text-caption pb-badge pb-badge-${config.tone}`)], [config.label]);
