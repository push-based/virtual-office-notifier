import { Input, Select, Textarea } from "@foldkit/ui";
import { Array } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

export interface TextFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly isMultiline?: boolean;
  readonly rows?: number;
  readonly isRequired?: boolean;
  readonly isDisabled?: boolean;
  readonly isCountHidden?: boolean;
  readonly isLabelStrong?: boolean;
}

const MULTILINE_ROWS = 3;

const fieldLabelClass = <Message>(config: TextFieldConfig<Message>): string =>
  config.isLabelStrong === true ? "text-body-sm label" : "text-body-sm pb-field-label";

const controlAttributes = <Message>(h: HtmlBuilder<Message>, config: TextFieldConfig<Message>) => [
  h.Class("text-body pb-field-control"),
  ...(config.maxLength === undefined ? [] : [h.Maxlength(config.maxLength)]),
  ...(config.placeholder === undefined ? [] : [h.Placeholder(config.placeholder)]),
  ...(config.isRequired === true ? [h.Required(true)] : []),
];

const counter = <Message>(h: HtmlBuilder<Message>, config: TextFieldConfig<Message>): Html =>
  config.maxLength === undefined || config.isCountHidden === true
    ? h.empty
    : h.span(
        [h.Class("text-caption pb-field-count"), h.AriaHidden(true)],
        [`${config.value.length}/${config.maxLength}`],
      );

const textareaField = <Message>(h: HtmlBuilder<Message>, config: TextFieldConfig<Message>): Html =>
  Textarea.view(
    {
      id: config.id,
      value: config.value,
      onInput: config.onInput,
      isDisabled: config.isDisabled === true,
      toView: (attributes) =>
        h.div(
          [h.Class("pb-field")],
          [
            h.label([...attributes.label, h.Class(fieldLabelClass(config))], [config.label]),
            h.textarea([
              ...attributes.textarea,
              ...controlAttributes(h, config),
              h.Rows(config.rows ?? MULTILINE_ROWS),
            ]),
            counter(h, config),
          ],
        ),
    },
    h,
  );

const inputField = <Message>(h: HtmlBuilder<Message>, config: TextFieldConfig<Message>): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      onInput: config.onInput,
      isDisabled: config.isDisabled === true,
      toView: (attributes) =>
        h.div(
          [h.Class("pb-field")],
          [
            h.label([...attributes.label, h.Class(fieldLabelClass(config))], [config.label]),
            h.input([...attributes.input, ...controlAttributes(h, config)]),
            counter(h, config),
          ],
        ),
    },
    h,
  );

export const textField = <Message>(
  h: HtmlBuilder<Message>,
  config: TextFieldConfig<Message>,
): Html => (config.isMultiline === true ? textareaField(h, config) : inputField(h, config));

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly options: ReadonlyArray<SelectOption>;
  readonly value: string;
  readonly onChange: (value: string) => Message;
  readonly isDisabled?: boolean;
}

const optionsOf = <Message>(
  h: HtmlBuilder<Message>,
  options: ReadonlyArray<SelectOption>,
  value: string,
): ReadonlyArray<Html> =>
  Array.map(options, (option) =>
    h.keyed("option")(
      option.value,
      [h.Value(option.value), h.Selected(option.value === value)],
      [option.label],
    ),
  );

export const selectField = <Message>(
  h: HtmlBuilder<Message>,
  config: SelectFieldConfig<Message>,
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      onChange: config.onChange,
      isDisabled: config.isDisabled === true,
      toView: (attributes) =>
        h.div(
          [h.Class("pb-field")],
          [
            h.label([...attributes.label, h.Class("text-body-sm pb-field-label")], [config.label]),
            h.select(
              [...attributes.select, h.Class("text-body pb-field-control")],
              optionsOf(h, config.options, config.value),
            ),
          ],
        ),
    },
    h,
  );

export const inlineSelect = <Message>(
  h: HtmlBuilder<Message>,
  config: SelectFieldConfig<Message>,
): Html =>
  Select.view(
    {
      id: config.id,
      value: config.value,
      onChange: config.onChange,
      isDisabled: config.isDisabled === true,
      toView: (attributes) =>
        h.select(
          [
            ...attributes.select,
            h.Class("text-body-sm pb-inline-select"),
            h.AriaLabel(config.label),
          ],
          optionsOf(h, config.options, config.value),
        ),
    },
    h,
  );
