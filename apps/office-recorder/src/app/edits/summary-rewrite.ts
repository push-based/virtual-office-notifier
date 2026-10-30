import { Component, booleanAttribute, computed, inject, input, output } from "@angular/core";
import { PbButton, PbNotice, PbNoticeRegion } from "design-system";

import { EditSaver } from "./edit-saver";

@Component({
  selector: "app-summary-rewrite",
  imports: [PbButton, PbNotice, PbNoticeRegion],
  providers: [EditSaver],
  template: `
    <button
      pbButton
      type="button"
      variant="ghost"
      class="rewrite"
      [disabled]="busy()"
      [attr.aria-busy]="busy()"
      (click)="rewrite()"
    >
      {{ busy() ? "Rewriting…" : "Rewrite summary" }}
    </button>
    <pb-notice-region>
      @if (saver.notice(); as notice) {
        <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
      }
    </pb-notice-region>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .rewrite {
      align-self: flex-start;
    }
  `,
})
export class SummaryRewrite {
  protected readonly saver = inject(EditSaver);

  readonly recordingId = input.required<string>();

  readonly rewriting = input(false, { transform: booleanAttribute });

  readonly saved = output();

  protected readonly busy = computed(() => this.saver.saving() || this.rewriting());

  protected rewrite(): void {
    this.saver.save(this.recordingId(), [{ kind: "rewrite_summary" }], () => this.saved.emit());
  }
}
