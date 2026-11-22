import { Disclosure } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export interface DisclosureConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly isOpen: boolean;
  readonly onToggle: (isOpen: boolean) => Message;
  readonly children: ReadonlyArray<Content>;
}

export const disclosure = <Message>(
  h: HtmlBuilder<Message>,
  config: DisclosureConfig<Message>,
): Html =>
  Disclosure.view(
    {
      id: config.id,
      isOpen: config.isOpen,
      onToggle: config.onToggle,
      toView: (attributes) =>
        h.div(
          [],
          [
            h.button(
              [...attributes.button, h.Class("text-body-sm pb-disclosure-button")],
              [config.label],
            ),
            h.div([...attributes.panel, h.Hidden(!config.isOpen)], config.children),
          ],
        ),
    },
    h,
  );
