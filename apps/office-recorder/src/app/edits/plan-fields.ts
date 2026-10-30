import { Component, booleanAttribute, input, model } from "@angular/core";
import { PbSelectField, PbTextField } from "design-system";

import {
  AGENDA_MAX_LENGTH,
  DEFAULT_SUMMARY_STYLE,
  type SummaryStyle,
  TITLE_MAX_LENGTH,
} from "./models";
import { STYLE_OPTIONS, summaryStyleOf } from "./plan";

@Component({
  selector: "app-plan-fields",
  imports: [PbSelectField, PbTextField],
  template: `
    <pb-text-field
      label="Title"
      placeholder="Deploy retro"
      [maxLength]="titleMaxLength"
      [disabled]="disabled()"
      [(value)]="title"
    />
    <pb-text-field
      label="Agenda"
      placeholder="What it's meant to cover"
      multiline
      [maxLength]="agendaMaxLength"
      [disabled]="disabled()"
      [(value)]="agenda"
    />
    <pb-select-field
      label="Summary"
      [options]="styleOptions"
      [disabled]="disabled()"
      [value]="summaryStyle()"
      (valueChange)="summaryStyle.set(styleOf($event))"
    />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }
  `,
})
export class PlanFields {
  readonly title = model("");

  readonly agenda = model("");

  readonly summaryStyle = model<SummaryStyle>(DEFAULT_SUMMARY_STYLE);

  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly titleMaxLength = TITLE_MAX_LENGTH;

  protected readonly agendaMaxLength = AGENDA_MAX_LENGTH;

  protected readonly styleOptions = STYLE_OPTIONS;

  protected readonly styleOf = summaryStyleOf;
}
