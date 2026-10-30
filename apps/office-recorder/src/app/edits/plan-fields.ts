import { Component, booleanAttribute, input, model } from "@angular/core";
import { PbTextField } from "design-system";

import { AGENDA_MAX_LENGTH, TITLE_MAX_LENGTH } from "./models";

@Component({
  selector: "app-plan-fields",
  imports: [PbTextField],
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

  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly titleMaxLength = TITLE_MAX_LENGTH;

  protected readonly agendaMaxLength = AGENDA_MAX_LENGTH;
}
