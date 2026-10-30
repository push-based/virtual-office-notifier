import { Component, inject, input, output } from "@angular/core";
import { PbAvatar, PbDescription, PbEyebrow, PbNotice, PbNoticeRegion } from "design-system";

import { EditSaver } from "./edit-saver";
import type { ActionItem, OfficeMember, RecordingChange } from "./models";

export const NO_ACTION_ITEMS = "No action items could be pulled out.";

export const NONE_TAKEN_ON = "Nobody took anything on.";

export const UNASSIGNED = "Unassigned";

export const tickOf = (item: ActionItem): RecordingChange => ({
  kind: item.done ? "untick" : "tick",
  item: item.id,
});

export const reassignOf = (item: ActionItem, chosen: string): ReadonlyArray<RecordingChange> => {
  const owner = chosen === "" ? null : chosen;

  return owner === (item.owner?.userId ?? null) ? [] : [{ kind: "reassign", item: item.id, owner }];
};

export const ownerChoices = (
  members: ReadonlyArray<OfficeMember>,
  owner: OfficeMember | null,
): ReadonlyArray<OfficeMember> =>
  owner === null || members.some(({ userId }) => userId === owner.userId)
    ? members
    : [owner, ...members];

@Component({
  selector: "app-action-items",
  imports: [PbAvatar, PbDescription, PbEyebrow, PbNotice, PbNoticeRegion],
  providers: [EditSaver],
  template: `
    <section aria-labelledby="action-items-heading">
      <p pbEyebrow tone="muted" id="action-items-heading">Action items</p>
      @if (items(); as items) {
        <ul class="items">
          @for (item of items; track item.id) {
            <li class="item" [class.done]="item.done">
              <input
                type="checkbox"
                class="tick"
                [checked]="item.done"
                [disabled]="saver.saving()"
                [attr.aria-label]="item.text"
                (change)="tick(item)"
              />
              <div class="body">
                <p class="text-body text">{{ item.text }}</p>
                <div class="owner">
                  @if (item.owner; as owner) {
                    <pb-avatar class="avatar" [name]="owner.name" [src]="owner.avatarUrl" />
                  }
                  <select
                    #choice
                    class="text-body-sm choice"
                    [attr.aria-label]="'Owner of ' + item.text"
                    [disabled]="saver.saving()"
                    (change)="reassign(item, choice.value)"
                  >
                    <option value="" [selected]="item.owner === null">{{ unassigned }}</option>
                    @for (member of choicesFor(item); track member.userId) {
                      <option
                        [value]="member.userId"
                        [selected]="member.userId === item.owner?.userId"
                      >
                        {{ member.name }}
                      </option>
                    }
                  </select>
                </div>
              </div>
            </li>
          } @empty {
            <li pbDescription>{{ noneTakenOn }}</li>
          }
        </ul>
      } @else {
        <p pbDescription>{{ noActionItems }}</p>
      }
      <pb-notice-region>
        @if (saver.notice(); as notice) {
          <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
        }
      </pb-notice-region>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }

    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .items {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
    }

    .item {
      display: flex;
      gap: var(--space-3);
      align-items: flex-start;
    }

    .tick {
      flex: none;
      width: var(--space-5);
      height: var(--space-5);
      margin: var(--space-0-5) 0 0;
      accent-color: var(--color-primary-600);
      cursor: pointer;
    }

    .tick:disabled,
    .choice:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .body {
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
      min-width: 0;
    }

    .text {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .done .text {
      text-decoration: line-through;
      color: var(--color-text-muted);
    }

    .owner {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .avatar {
      width: var(--space-6);
      height: var(--space-6);
    }

    .choice {
      max-width: 100%;
      padding: var(--space-1) var(--space-2);
      font-family: var(--font-sans);
      color: var(--color-text);
      background: var(--color-surface);
      border: 1px solid var(--color-neutral-300);
      border-radius: var(--radius-lg);
    }

    .choice:focus-visible {
      outline: none;
      border-color: var(--color-primary-300);
      box-shadow: var(--shadow-focus);
    }
  `,
})
export class ActionItems {
  protected readonly saver = inject(EditSaver);

  readonly recordingId = input.required<string>();

  readonly items = input.required<ReadonlyArray<ActionItem> | null>();

  readonly members = input.required<ReadonlyArray<OfficeMember>>();

  readonly saved = output();

  protected readonly unassigned = UNASSIGNED;

  protected readonly noActionItems = NO_ACTION_ITEMS;

  protected readonly noneTakenOn = NONE_TAKEN_ON;

  protected choicesFor(item: ActionItem): ReadonlyArray<OfficeMember> {
    return ownerChoices(this.members(), item.owner);
  }

  protected tick(item: ActionItem): void {
    this.save([tickOf(item)]);
  }

  protected reassign(item: ActionItem, chosen: string): void {
    this.save(reassignOf(item, chosen));
  }

  private save(changes: ReadonlyArray<RecordingChange>): void {
    this.saver.save(this.recordingId(), changes, () => this.saved.emit());
  }
}
