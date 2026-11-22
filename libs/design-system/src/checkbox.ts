import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export interface CheckboxConfig<Message> {
  readonly id: string;
  readonly isChecked: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
  readonly isDisabled?: boolean;
}

export const checkbox = <Message>(h: HtmlBuilder<Message>, config: CheckboxConfig<Message>): Html =>
  h.span(
    [h.Class("pb-checkbox")],
    [
      h.input([
        h.Type("checkbox"),
        h.Id(config.id),
        h.Checked(config.isChecked),
        h.Disabled(config.isDisabled === true),
        h.OnClick(config.onToggle(!config.isChecked)),
      ]),
    ],
  );

export interface CheckboxLabelConfig {
  readonly checkboxId: string;
  readonly text: Content;
  readonly className?: string;
}

export const checkboxLabel = <Message>(
  h: HtmlBuilder<Message>,
  config: CheckboxLabelConfig,
): Html =>
  h.label(
    [
      h.For(config.checkboxId),
      h.Class(
        config.className === undefined
          ? "text-body pb-checkbox-label"
          : `text-body pb-checkbox-label ${config.className}`,
      ),
    ],
    [config.text],
  );
