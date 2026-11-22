import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export const card = <Message>(h: HtmlBuilder<Message>, children: ReadonlyArray<Content>): Html =>
  h.section([h.Class("pb-card")], children);
