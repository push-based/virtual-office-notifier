import { selectField, textField } from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";

import { AGENDA_MAX_LENGTH, TITLE_MAX_LENGTH } from "../wire.ts";
import { type Draft, STYLE_OPTIONS } from "./plan.ts";

export interface PlanFieldsConfig<Message> {
  readonly idPrefix: string;
  readonly draft: Draft;
  readonly isDisabled: boolean;
  readonly onTitle: (value: string) => Message;
  readonly onAgenda: (value: string) => Message;
  readonly onSummaryStyle: (value: string) => Message;
}

export const planFields = <Message>(
  h: HtmlBuilder<Message>,
  config: PlanFieldsConfig<Message>,
): Html =>
  h.div(
    [h.Class("plan-fields")],
    [
      textField(h, {
        id: `${config.idPrefix}-title`,
        label: "Title",
        placeholder: "Deploy retro",
        maxLength: TITLE_MAX_LENGTH,
        value: config.draft.title,
        isDisabled: config.isDisabled,
        onInput: config.onTitle,
      }),
      textField(h, {
        id: `${config.idPrefix}-agenda`,
        label: "Agenda",
        placeholder: "What it's meant to cover",
        isMultiline: true,
        maxLength: AGENDA_MAX_LENGTH,
        value: config.draft.agenda,
        isDisabled: config.isDisabled,
        onInput: config.onAgenda,
      }),
      selectField(h, {
        id: `${config.idPrefix}-summary-style`,
        label: "Summary",
        options: STYLE_OPTIONS,
        value: config.draft.summaryStyle,
        isDisabled: config.isDisabled,
        onChange: config.onSummaryStyle,
      }),
    ],
  );
