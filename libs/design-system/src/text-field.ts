import { Component, booleanAttribute, computed, input, model } from "@angular/core";

@Component({
  selector: "pb-text-field",
  template: `
    <label class="field">
      <span class="text-body-sm label">{{ label() }}</span>
      @if (multiline()) {
        <textarea
          #control
          class="text-body control"
          rows="3"
          [value]="value()"
          [attr.maxlength]="maxLength()"
          [attr.placeholder]="placeholder()"
          [disabled]="disabled()"
          (input)="value.set(control.value)"
        ></textarea>
      } @else {
        <input
          #control
          class="text-body control"
          type="text"
          [value]="value()"
          [attr.maxlength]="maxLength()"
          [attr.placeholder]="placeholder()"
          [disabled]="disabled()"
          (input)="value.set(control.value)"
        />
      }
      @if (count(); as count) {
        <span class="text-caption count" aria-hidden="true">{{ count }}</span>
      }
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

    textarea.control {
      resize: vertical;
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

    .count {
      align-self: flex-end;
      color: var(--color-text-muted);
    }
  `,
})
export class PbTextField {
  readonly label = input.required<string>();

  readonly value = model("");

  readonly maxLength = input<number | null>(null);

  readonly placeholder = input<string | null>(null);

  readonly multiline = input(false, { transform: booleanAttribute });

  readonly disabled = input(false, { transform: booleanAttribute });

  protected readonly count = computed(() => {
    const maxLength = this.maxLength();

    return maxLength === null ? null : `${this.value().length}/${maxLength}`;
  });
}
