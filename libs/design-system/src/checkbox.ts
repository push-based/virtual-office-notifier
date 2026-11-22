import { Checkbox } from "@foldkit/ui";
import type { Html, HtmlBuilder } from "foldkit/html";

export interface CheckboxConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly isChecked: boolean;
  readonly onToggle: (isChecked: boolean) => Message;
  readonly isDisabled?: boolean;
}

export const checkbox = <Message>(
  h: HtmlBuilder<Message>,
  config: CheckboxConfig<Message>,
): Html => {
  const isDisabled = config.isDisabled === true;

  return Checkbox.view(
    {
      id: config.id,
      isChecked: config.isChecked,
      onToggle: config.onToggle,
      isDisabled,
      toView: (attributes) =>
        h.span(
          [h.Class("pb-checkbox")],
          [
            h.input([
              ...attributes.checkbox,
              h.Type("checkbox"),
              h.Checked(config.isChecked),
              h.Disabled(isDisabled),
            ]),
            h.span([...attributes.label, h.Class("sr-only")], [config.label]),
          ],
        ),
    },
    h,
  );
};
