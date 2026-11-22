import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export type EyebrowTone = "brand" | "muted";

export interface EyebrowConfig {
  readonly text: string;
  readonly tone?: EyebrowTone;
  readonly id?: string;
}

export const eyebrow = <Message>(h: HtmlBuilder<Message>, config: EyebrowConfig): Html =>
  h.p(
    [
      h.Class(
        config.tone === "muted"
          ? "text-subtitle pb-eyebrow pb-eyebrow-muted"
          : "text-subtitle pb-eyebrow",
      ),
      ...(config.id === undefined ? [] : [h.Id(config.id)]),
    ],
    [config.text],
  );

export const description = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Content>,
): Html => h.p([h.Class("text-body-sm pb-description")], children);

export const descriptionItem = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Content>,
): Html => h.li([h.Class("text-body-sm pb-description")], children);

export interface HeadingConfig {
  readonly text: string;
}

export const heading = <Message>(h: HtmlBuilder<Message>, config: HeadingConfig): Html =>
  h.h2([h.Class("text-section-title pb-heading")], [config.text]);

export const divider = <Message>(h: HtmlBuilder<Message>): Html => h.hr([h.Class("pb-divider")]);
