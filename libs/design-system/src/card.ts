import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export type CardSize = "md" | "lg";

export const card = <Message>(
  h: HtmlBuilder<Message>,
  size: CardSize,
  children: ReadonlyArray<Content>,
): Html => h.section([h.Class(size === "lg" ? "pb-card pb-card-lg" : "pb-card")], children);
