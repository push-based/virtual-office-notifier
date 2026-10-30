import { Component, inject, input, output, signal } from "@angular/core";
import { PbButton, PbNotice, PbNoticeRegion } from "design-system";

import { EditSaver } from "./edit-saver";
import { PlanFields } from "./plan-fields";
import { changesBetween, draftOf } from "./plan";

@Component({
  selector: "app-recording-editor",
  imports: [PbButton, PbNotice, PbNoticeRegion, PlanFields],
  providers: [EditSaver],
  template: `
    @if (open()) {
      <app-plan-fields [(title)]="title" [(agenda)]="agenda" [disabled]="saver.saving()" />
      <div class="actions">
        <button
          pbButton
          type="button"
          class="save"
          [disabled]="saver.saving()"
          [attr.aria-busy]="saver.saving()"
          (click)="save()"
        >
          {{ saver.saving() ? "Saving…" : "Save" }}
        </button>
        <button
          pbButton
          type="button"
          variant="ghost"
          class="cancel"
          [disabled]="saver.saving()"
          (click)="open.set(false)"
        >
          Cancel
        </button>
      </div>
    } @else {
      <button pbButton type="button" variant="ghost" class="edit" (click)="edit()">
        {{ label() }}
      </button>
    }
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

    .actions {
      display: flex;
      gap: var(--space-3);
    }

    .edit {
      align-self: flex-start;
    }
  `,
})
export class RecordingEditor {
  protected readonly saver = inject(EditSaver);

  readonly recordingId = input.required<string>();

  readonly currentTitle = input.required<string | null>();

  readonly currentAgenda = input.required<string | null>();

  readonly label = input("Edit");

  readonly saved = output();

  protected readonly open = signal(false);

  protected readonly title = signal("");

  protected readonly agenda = signal("");

  protected edit(): void {
    const draft = draftOf({ title: this.currentTitle(), agenda: this.currentAgenda() });

    this.title.set(draft.title);
    this.agenda.set(draft.agenda);
    this.open.set(true);
  }

  protected save(): void {
    const changes = changesBetween(
      { title: this.currentTitle(), agenda: this.currentAgenda() },
      { title: this.title(), agenda: this.agenda() },
    );

    this.saver.save(this.recordingId(), changes, () => {
      this.open.set(false);
      this.saved.emit();
    });
  }
}
