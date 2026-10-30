import { Component, input, output } from "@angular/core";
import { PbButton } from "design-system";

@Component({
  selector: "app-record-button",
  imports: [PbButton],
  template: `
    <button
      pbButton
      type="button"
      variant="primary"
      size="lg"
      fullWidth
      [disabled]="disabled()"
      [attr.aria-busy]="busy()"
      (click)="pressed.emit()"
    >
      <span class="icon" aria-hidden="true"></span>
      {{ recording() ? "Stop recording" : "Start recording" }}
    </button>
  `,
  styles: `
    :host {
      display: block;
    }

    button {
      gap: var(--space-2);
    }

    .icon {
      width: var(--space-3);
      height: var(--space-3);
      border-radius: var(--radius-full);
      background: currentColor;
    }

    :host(.recording) .icon {
      border-radius: var(--radius-sm);
    }
  `,
  host: { "[class.recording]": "recording()" },
})
export class RecordButton {
  readonly recording = input.required<boolean>();

  readonly busy = input.required<boolean>();

  readonly disabled = input.required<boolean>();

  readonly pressed = output();
}
