import { Component, input, output } from "@angular/core";

import { PbButton } from "./button";

@Component({
  selector: "pb-record-button",
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
      {{ recording() ? stopLabel() : startLabel() }}
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
export class PbRecordButton {
  readonly recording = input(false);

  readonly busy = input(false);

  readonly disabled = input(false);

  readonly startLabel = input("Start recording");

  readonly stopLabel = input("Stop recording");

  readonly pressed = output();
}
