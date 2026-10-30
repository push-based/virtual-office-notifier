import { Component, booleanAttribute, input, model } from "@angular/core";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

@Component({
  selector: "pb-select-field",
  template: `
    <label class="field">
      <span class="text-body-sm label">{{ label() }}</span>
      <select
        #control
        class="text-body control"
        [disabled]="disabled()"
        (change)="value.set(control.value)"
      >
        @for (option of options(); track option.value) {
          <option [value]="option.value" [selected]="option.value === value()">
            {{ option.label }}
          </option>
        }
      </select>
    </label>
  `,
  styles: `
    :host {
      display: block;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
    }

    .label {
      font-weight: 500;
      color: var(--color-text-heading);
    }

    .control {
      width: 100%;
      margin: 0;
      padding: var(--space-2) var(--space-3);
      font-family: var(--font-sans);
      color: var(--color-text);
      background: var(--color-surface);
      border: 1px solid var(--color-neutral-300);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      transition: border-color 0.2s ease-out;
    }

    .control:focus-visible {
      outline: none;
      border-color: var(--color-primary-300);
      box-shadow: var(--shadow-focus);
    }

    .control:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,
})
export class PbSelectField {
  readonly label = input.required<string>();

  readonly options = input.required<ReadonlyArray<SelectOption>>();

  readonly value = model("");

  readonly disabled = input(false, { transform: booleanAttribute });
}
