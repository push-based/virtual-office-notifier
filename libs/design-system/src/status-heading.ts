import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

import { description } from "./text.ts";

export type HeadingLevel = 1 | 2 | 3;

export interface StatusHeadingConfig {
  readonly heading: string;
  readonly subheading: string | null;
  readonly description: string;
  readonly isLive?: boolean;
  readonly level?: HeadingLevel;
}

const liveDot = <Message>(h: HtmlBuilder<Message>): Html =>
  h.span([h.Class("pb-live-dot"), h.AriaHidden(true)]);

const headingAt = <Message>(
  h: HtmlBuilder<Message>,
  level: HeadingLevel,
  children: ReadonlyArray<Content>,
): Html => {
  const attributes = [h.Class("text-section-title pb-heading text-tabular")];

  if (level === 1) return h.h1(attributes, children);

  if (level === 2) return h.h2(attributes, children);

  return h.h3(attributes, children);
};

export const statusHeading = <Message>(
  h: HtmlBuilder<Message>,
  config: StatusHeadingConfig,
): Html =>
  h.div(
    [h.Class("pb-status-heading")],
    [
      headingAt(h, config.level ?? 1, [
        config.isLive === true ? liveDot(h) : h.empty,
        config.heading,
      ]),
      config.subheading === null
        ? h.empty
        : h.p([h.Class("text-body pb-status-heading-subheading")], [config.subheading]),
      description(h, [config.description]),
    ],
  );
