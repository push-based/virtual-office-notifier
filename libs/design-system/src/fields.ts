import type { Html, HtmlBuilder } from "foldkit/html";

export interface TextFieldConfig<Message> {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => Message;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly isMultiline?: boolean;
  readonly isDisabled?: boolean;
}

export const textField = <Message>(
  h: HtmlBuilder<Message>,
  config: TextFieldConfig<Message>,
): Html => {
  const controlAttributes = [
    h.Id(config.id),
    h.Class("text-body pb-field-control"),
    h.Value(config.value),
    h.Disabled(config.isDisabled === true),
    h.OnInput(config.onInput),
    ...(config.maxLength === undefined ? [] : [h.Maxlength(config.maxLength)]),
    ...(config.placeholder === undefined ? [] : [h.Placeholder(config.placeholder)]),
  ];

  return h.div(
    [h.Class("pb-field")],
    [
      h.label([h.Class("text-body-sm pb-field-label"), h.For(config.id)], [config.label]),
      config.isMultiline === true
        ? h.textarea([...controlAttributes, h.Rows(3)])
        : h.input([...controlAttributes, h.Type("text")]),
      config.maxLength === undefined
        ? h.empty
        : h.span(
            [h.Class("text-caption pb-field-count"), h.AriaHidden(true)],
            [`${config.value.length}/${config.maxLength}`],
          ),
    ],
  );
};

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

export const selectField = <Message>(
  h: HtmlBuilder<Message>,
  config: SelectFieldConfig<Message>,
): Html =>
  h.div(
    [h.Class("pb-field")],
    [
      h.label([h.Class("text-body-sm pb-field-label"), h.For(config.id)], [config.label]),
      h.select(
        [
          h.Id(config.id),
          h.Class("text-body pb-field-control"),
          h.Disabled(config.isDisabled === true),
          h.OnChange(config.onChange),
        ],
        config.options.map((option) =>
          h.keyed("option")(
            option.value,
            [h.Value(option.value), h.Selected(option.value === config.value)],
            [option.label],
          ),
        ),
      ),
    ],
  );
