import { Component, DestroyRef, inject, signal } from "@angular/core";
import { rxResource, takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
  type NoticeKind,
  PbButton,
  PbCard,
  PbDescription,
  PbEyebrow,
  PbNotice,
  PbNoticeRegion,
  PbSelectField,
  type SelectOption,
} from "design-system";
import { type ErasureCase, type RefusalGround, REFUSAL_GROUNDS } from "recording-requests/wire";

import { formatOfficeTime } from "../history/describe-recording";
import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { adminName, describeInventory, groundLabel } from "./describe-erasure";

interface AdminNotice {
  readonly kind: NoticeKind;
  readonly text: string;
}

type Confirming = { readonly id: number; readonly action: "now" | "refuse" };

const GROUNDS: ReadonlyArray<SelectOption> = [
  { value: "legal_obligation", label: REFUSAL_GROUNDS.legal_obligation },
  { value: "legal_claim", label: REFUSAL_GROUNDS.legal_claim },
];

const groundOf = (value: string): RefusalGround =>
  value === "legal_claim" ? "legal_claim" : "legal_obligation";

const NOTED_NOW: AdminNotice = {
  kind: "info",
  text: "Noted. The bot deletes it within a minute, then tells them.",
};

const NOTED_SEEN: AdminNotice = {
  kind: "info",
  text: "Noted as seen. It still runs on the due date unless someone acts.",
};

const NOTED_REFUSED: AdminNotice = {
  kind: "info",
  text: "Refused. They'll be told why, and that they can complain.",
};

const ALREADY_DECIDED: AdminNotice = {
  kind: "error",
  text: "That request was already decided, or the deletion has already run.",
};

const FAILED: AdminNotice = {
  kind: "error",
  text: "Couldn't reach the bot's records. Nothing changed, so try again in a moment.",
};

@Component({
  selector: "app-erasure-admin",
  imports: [PbButton, PbCard, PbDescription, PbEyebrow, PbNotice, PbNoticeRegion, PbSelectField],
  template: `
    <pb-card size="lg">
      <p pbEyebrow>Deletion requests</p>
      @if (cases.error(); as error) {
        <pb-notice kind="error">Couldn't load the deletion requests: {{ error.message }}</pb-notice>
      } @else if (cases.value(); as list) {
        @if (list.length === 0) {
          <p pbDescription>Nobody has asked for their data to be deleted.</p>
        }
        @for (erasure of list; track erasure.id) {
          <article class="case" [attr.aria-labelledby]="'case-' + erasure.id">
            <h3 [id]="'case-' + erasure.id" class="text-body label">
              {{ erasure.displayName ?? "A member" }}
              <span class="text-body-sm muted"
                >Discord ID {{ erasure.userId }} · request #{{ erasure.id }}</span
              >
            </h3>
            <p pbDescription>
              Asked on {{ when(erasure.requestedAt) }}. Unless someone acts, it's deleted on
              {{ when(erasure.dueAt) }}. {{ standing(erasure) }}
            </p>
            <p pbDescription>
              Under Article 17 of the GDPR this is their right. Refusing needs one of two grounds: a
              legal obligation to keep the data, or an ongoing legal claim that needs it. The reason
              goes to them word for word, with their right to complain to a data protection
              authority.
            </p>
            <h4 class="text-body-sm label">What will be deleted</h4>
            <ul class="text-body-sm">
              @for (line of inventory(erasure); track $index) {
                <li>{{ line }}</li>
              }
            </ul>
            @if (erasure.decision === null) {
              @if (confirming()?.id === erasure.id && confirming()?.action === "now") {
                <div class="confirm danger" role="group">
                  <p class="text-body-sm">
                    This runs the deletion within a minute, and it can't be undone.
                  </p>
                  <div class="controls">
                    <button
                      pbButton
                      type="button"
                      [disabled]="busy() !== null"
                      (click)="expedite(erasure.id)"
                    >
                      {{ busy() === erasure.id ? "Working…" : "Delete now" }}
                    </button>
                    <button
                      pbButton
                      type="button"
                      variant="ghost"
                      [disabled]="busy() !== null"
                      (click)="confirming.set(null)"
                    >
                      Back
                    </button>
                  </div>
                </div>
              } @else if (confirming()?.id === erasure.id && confirming()?.action === "refuse") {
                <form class="confirm danger" (submit)="refuse($event, erasure.id)">
                  <pb-select-field label="Ground" [options]="grounds" [(value)]="ground" />
                  <label class="field">
                    <span class="text-body-sm label">
                      Why it has to be kept. This goes to them, word for word.
                    </span>
                    <textarea
                      class="text-body control"
                      rows="4"
                      required
                      maxlength="1000"
                      [value]="reason()"
                      (input)="reason.set(reasonInput.value)"
                      #reasonInput
                    ></textarea>
                  </label>
                  <div class="controls">
                    <button
                      pbButton
                      type="submit"
                      [disabled]="busy() !== null || reason().trim() === ''"
                    >
                      {{ busy() === erasure.id ? "Working…" : "Refuse the deletion" }}
                    </button>
                    <button
                      pbButton
                      type="button"
                      variant="ghost"
                      [disabled]="busy() !== null"
                      (click)="confirming.set(null)"
                    >
                      Keep it open
                    </button>
                  </div>
                </form>
              } @else {
                <div class="controls">
                  <button
                    pbButton
                    type="button"
                    [disabled]="busy() !== null"
                    (click)="confirming.set({ id: erasure.id, action: 'now' })"
                  >
                    Delete now
                  </button>
                  <button
                    pbButton
                    type="button"
                    variant="ghost"
                    [disabled]="busy() !== null"
                    (click)="seen(erasure.id)"
                  >
                    Let it run
                  </button>
                  <button
                    pbButton
                    type="button"
                    variant="ghost"
                    [disabled]="busy() !== null"
                    (click)="confirming.set({ id: erasure.id, action: 'refuse' })"
                  >
                    Refuse…
                  </button>
                </div>
              }
            }
          </article>
        }
      } @else {
        <p pbDescription>Loading…</p>
      }
      <pb-notice-region>
        @if (notice(); as notice) {
          <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
        }
      </pb-notice-region>
    </pb-card>
  `,
  styles: `
    :host {
      display: block;
    }

    .case {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-border);
    }

    .case p {
      margin: 0;
    }

    .label {
      margin: 0;
      font-weight: 600;
      color: var(--color-text-heading);
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: baseline;
    }

    .muted {
      font-weight: 400;
      color: var(--color-text-muted);
    }

    ul {
      margin: 0;
      padding-left: var(--space-5);
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      color: var(--color-text);
    }

    .confirm {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }

    .confirm.danger {
      border-color: var(--color-error-300);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-1-5);
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
      resize: vertical;
    }

    .control:focus-visible {
      outline: none;
      border-color: var(--color-primary-300);
      box-shadow: var(--shadow-focus);
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
    }
  `,
})
export class ErasureAdmin {
  private readonly api = inject(ConsentApi);

  private readonly session = inject(RecorderSession);

  private readonly destroyRef = inject(DestroyRef);

  protected readonly grounds = GROUNDS;

  protected readonly confirming = signal<Confirming | null>(null);

  protected readonly busy = signal<number | null>(null);

  protected readonly notice = signal<AdminNotice | null>(null);

  protected readonly ground = signal<string>("legal_obligation");

  protected readonly reason = signal("");

  protected readonly cases = rxResource({
    params: () => (this.session.token() === null ? undefined : this.session.token()),
    stream: () => this.api.cases(),
  });

  protected when(iso: string): string {
    return `${formatOfficeTime(iso)}, UTC+2`;
  }

  protected inventory(erasure: ErasureCase): ReadonlyArray<string> {
    return describeInventory(erasure.inventory);
  }

  protected standing(erasure: ErasureCase): string {
    switch (erasure.decision) {
      case "now":
        return `${adminName(erasure.decidedBy ?? "")} asked for it to run now; the bot is on it.`;
      case "refused":
        return `${adminName(erasure.decidedBy ?? "")} refused it because of ${groundLabel(erasure.refusal?.ground ?? "legal_obligation")}; the bot is telling them.`;
      case "cancelled":
        return "They cancelled it, or agreed to being recorded again; the bot is closing it.";
      case null:
        return erasure.seenBy.length === 0
          ? "Nobody has looked at it yet."
          : `Seen by ${erasure.seenBy.map(adminName).join(" and ")}.`;
    }
  }

  protected expedite(id: number): void {
    this.act(id, () => this.api.expedite(id), NOTED_NOW);
  }

  protected seen(id: number): void {
    this.act(id, () => this.api.seen(id), NOTED_SEEN);
  }

  protected refuse(event: Event, id: number): void {
    event.preventDefault();

    const reason = this.reason().trim();

    if (reason === "") return;

    this.act(
      id,
      () => this.api.refuse(id, { ground: groundOf(this.ground()), reason }),
      NOTED_REFUSED,
    );
  }

  private act(id: number, call: () => ReturnType<ConsentApi["seen"]>, done: AdminNotice): void {
    this.busy.set(id);
    this.notice.set(null);

    call()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.settle(done),
        error: (error: Error) =>
          this.settle(error.message.endsWith("answered 404") ? ALREADY_DECIDED : FAILED),
      });
  }

  private settle(notice: AdminNotice): void {
    this.busy.set(null);
    this.confirming.set(null);
    this.reason.set("");
    this.notice.set(notice);
    this.cases.reload();
  }
}
