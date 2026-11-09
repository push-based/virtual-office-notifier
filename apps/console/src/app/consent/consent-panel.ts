import { Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { rxResource, takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
  type NoticeKind,
  PbButton,
  PbCard,
  PbDescription,
  PbEyebrow,
  PbNotice,
  PbNoticeRegion,
  PbStatusHeading,
} from "design-system";
import {
  ANSWER_WINDOW_MS,
  CHECK_INTERVAL_MS,
  DATA_PROTECTION_AUTHORITIES_URL,
  ERASURE_REVIEW_DAYS,
  RECORDED_IN_THE_OFFICE,
  type SubmittedWithdrawal,
} from "recording-requests/wire";
import { type Observable, first, of, switchMap, timeout, timer } from "rxjs";

import { formatOfficeTime } from "../history/describe-recording";
import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { describeConsent } from "./describe-consent";
import { groundLabel } from "./describe-erasure";
import { ErasureAdmin } from "./erasure-admin";

interface ConsentNotice {
  readonly kind: NoticeKind;
  readonly text: string;
}

const WITHDRAWN: ConsentNotice = {
  kind: "info",
  text: "Your consent is withdrawn. If you were in the office, the bot has shown you out, and it's sent you a DM. We'll miss you.",
};

const NOTHING_TO_WITHDRAW: ConsentNotice = {
  kind: "info",
  text: "There was nothing to withdraw: you hadn't agreed to being recorded.",
};

const NO_ANSWER: ConsentNotice = {
  kind: "error",
  text: "The bot didn't answer in time. It'll still withdraw your consent once it's back.",
};

const SCHEDULED: ConsentNotice = {
  kind: "info",
  text: "Done. Your consent is withdrawn, the bot will show you out if you're in and send you a DM with the date, and the office admins have been told what will be deleted.",
};

const NOT_SCHEDULED: ConsentNotice = {
  kind: "error",
  text: "Couldn't ask for your data to be deleted. Nothing has changed, so try again in a moment.",
};

const CANCELLED: ConsentNotice = {
  kind: "info",
  text: "Your deletion request is cancelled. Nothing was deleted, and the bot will send you a DM.",
};

const NOT_CANCELLED: ConsentNotice = {
  kind: "error",
  text: "Couldn't cancel the request. It may already have run, or the bot's records are out of reach. Check again in a moment.",
};

type Action = "withdraw" | "erase" | "cancel";

const noticeOf = (withdrawal: SubmittedWithdrawal): ConsentNotice =>
  withdrawal.outcome === "ignored" ? NOTHING_TO_WITHDRAW : WITHDRAWN;

@Component({
  selector: "app-consent-panel",
  imports: [
    ErasureAdmin,
    PbButton,
    PbCard,
    PbDescription,
    PbEyebrow,
    PbNotice,
    PbNoticeRegion,
    PbStatusHeading,
  ],
  template: `
    <div class="panels">
      <pb-card size="lg">
        <p pbEyebrow>Privacy</p>
        @if (status.error(); as error) {
          <pb-notice kind="error">Couldn't check your consent: {{ error.message }}</pb-notice>
          <button
            pbButton
            type="button"
            variant="ghost"
            class="align-start"
            [disabled]="status.isLoading()"
            (click)="status.reload()"
          >
            {{ status.isLoading() ? "Checking…" : "Try again" }}
          </button>
        } @else if (view(); as view) {
          <pb-status-heading
            [heading]="view.heading"
            [description]="view.description"
            [level]="2"
          />
          <section class="recorded" aria-labelledby="recorded-heading">
            <h3 id="recorded-heading" class="text-body-sm label">
              While you're in the office, it records
            </h3>
            <ul class="text-body-sm">
              @for (item of recorded; track item) {
                <li>{{ item }}</li>
              }
            </ul>
            <p pbDescription>
              It's shared in the office Slack channel, and AI models read it to write the office
              banter and summarise recordings. That's how the office works, so it can't be switched
              off for one person.
            </p>
          </section>
          @if (view.canCancel && pendingErasureId() !== null) {
            @if (confirming() === "cancel") {
              <div class="confirm" role="group" aria-labelledby="confirm-cancel-text">
                <p id="confirm-cancel-text" class="text-body-sm">
                  Cancelling keeps everything as it is. Your consent stays withdrawn until you agree
                  again, which the bot asks you next time you join the office.
                </p>
                <div class="controls">
                  <button
                    pbButton
                    type="button"
                    [disabled]="busy() !== null"
                    [attr.aria-busy]="busy() === 'cancel'"
                    (click)="cancel()"
                  >
                    {{ busy() === "cancel" ? "Cancelling…" : "Cancel the deletion" }}
                  </button>
                  <button
                    pbButton
                    type="button"
                    variant="ghost"
                    [disabled]="busy() !== null"
                    (click)="confirming.set(null)"
                  >
                    Keep the request
                  </button>
                </div>
              </div>
            } @else {
              <button
                pbButton
                type="button"
                variant="ghost"
                class="align-start"
                [disabled]="busy() !== null"
                (click)="confirming.set('cancel')"
              >
                Cancel the deletion
              </button>
            }
          }
          @if (view.refusal; as refusal) {
            <section class="refusal" aria-labelledby="refusal-heading">
              <h3 id="refusal-heading" class="text-body-sm label">Why your data wasn't deleted</h3>
              <p pbDescription>
                On {{ when(refusal.refusedAt) }} the office admins refused your request because of
                {{ ground(refusal.ground) }}. In their words:
              </p>
              <blockquote class="text-body-sm">{{ refusal.reason }}</blockquote>
              <p pbDescription>
                Your consent stays withdrawn, so nothing new is recorded about you. If you think
                that's wrong, you can complain to a data protection authority.
              </p>
              <button
                pbButton
                type="button"
                variant="ghost"
                class="align-start"
                (click)="openAuthorities()"
              >
                Data protection authorities
              </button>
            </section>
          }
          @if (view.canWithdraw) {
            @if (confirming() === "withdraw") {
              <div class="confirm" role="group" aria-labelledby="confirm-withdraw-text">
                <p id="confirm-withdraw-text" class="text-body-sm">
                  Withdrawing shows you out of the office straight away, and nothing new is recorded
                  about you. What's already recorded stays until you ask for it to be deleted. If
                  you come back, the bot will ask you again.
                </p>
                <div class="controls">
                  <button
                    pbButton
                    type="button"
                    [disabled]="busy() !== null"
                    [attr.aria-busy]="busy() === 'withdraw'"
                    (click)="withdraw()"
                  >
                    {{ busy() === "withdraw" ? "Withdrawing…" : "Withdraw my consent" }}
                  </button>
                  <button
                    pbButton
                    type="button"
                    variant="ghost"
                    [disabled]="busy() !== null"
                    (click)="confirming.set(null)"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            } @else {
              <button
                pbButton
                type="button"
                variant="ghost"
                class="align-start"
                [disabled]="busy() !== null"
                (click)="confirming.set('withdraw')"
              >
                Withdraw consent
              </button>
            }
          }
          @if (view.canErase) {
            <section class="erase" aria-labelledby="erase-heading">
              <h3 id="erase-heading" class="text-body-sm label">Delete your data</h3>
              <p pbDescription>
                Asks for everything the office holds about you to be deleted: your activity, your
                sounds and emoji, the Slack messages the bot kept, and your lines and audio in every
                recording. Each recording you spoke in gets a new summary without you, and your name
                is taken out of everything else, like other people's lines and the bot's posts in
                Slack. Your consent is withdrawn straight away. The deletion runs
                {{ reviewDays }} days later, or sooner if the office admins decide so, which gives
                them time to check that nothing has to be kept by law. You can cancel until then.
              </p>
              @if (confirming() === "erase") {
                <div class="confirm danger" role="group" aria-labelledby="confirm-erase-text">
                  <p id="confirm-erase-text" class="text-body-sm">
                    Once it runs, this can't be undone. If you're in the office, the bot shows you
                    out now, and if you come back before it runs, agreeing to being recorded cancels
                    it.
                  </p>
                  <div class="controls">
                    <button
                      pbButton
                      type="button"
                      [disabled]="busy() !== null"
                      [attr.aria-busy]="busy() === 'erase'"
                      (click)="erase()"
                    >
                      {{ busy() === "erase" ? "Asking…" : "Delete everything" }}
                    </button>
                    <button
                      pbButton
                      type="button"
                      variant="ghost"
                      [disabled]="busy() !== null"
                      (click)="confirming.set(null)"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              } @else {
                <button
                  pbButton
                  type="button"
                  variant="ghost"
                  class="align-start"
                  [disabled]="busy() !== null"
                  (click)="confirming.set('erase')"
                >
                  Delete my data
                </button>
              }
            </section>
          }
        } @else {
          <p pbDescription>Checking…</p>
        }
        <pb-notice-region>
          @if (notice(); as notice) {
            <pb-notice [kind]="notice.kind">{{ notice.text }}</pb-notice>
          }
        </pb-notice-region>
      </pb-card>
      @if (status.value()?.admin) {
        <app-erasure-admin />
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }

    .panels {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }

    .align-start {
      align-self: flex-start;
    }

    .recorded,
    .erase,
    .refusal {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .erase,
    .refusal {
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-border);
    }

    .erase p,
    .refusal p {
      margin: 0;
    }

    blockquote {
      margin: 0;
      padding-left: var(--space-3);
      border-left: 3px solid var(--color-border);
      color: var(--color-text);
    }

    .label {
      margin: 0;
      font-weight: 600;
      color: var(--color-text-heading);
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

    .confirm p {
      margin: 0;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
    }
  `,
})
export class ConsentPanel {
  private readonly api = inject(ConsentApi);

  private readonly session = inject(RecorderSession);

  private readonly destroyRef = inject(DestroyRef);

  protected readonly recorded = RECORDED_IN_THE_OFFICE;

  protected readonly reviewDays = ERASURE_REVIEW_DAYS;

  protected readonly confirming = signal<Action | null>(null);

  protected readonly busy = signal<Action | null>(null);

  protected readonly notice = signal<ConsentNotice | null>(null);

  protected readonly status = rxResource({
    params: () => (this.session.token() === null ? undefined : this.session.token()),
    stream: () => this.api.status(),
  });

  protected readonly view = computed(() => {
    const status = this.status.value();

    return status === undefined ? null : describeConsent(status);
  });

  protected readonly pendingErasureId = computed(
    () => this.status.value()?.pendingErasure?.id ?? null,
  );

  protected when(iso: string): string {
    return `${formatOfficeTime(iso)}, UTC+2`;
  }

  protected ground = groundLabel;

  protected openAuthorities(): void {
    void this.session.openExternalLink(DATA_PROTECTION_AUTHORITIES_URL);
  }

  protected withdraw(): void {
    this.busy.set("withdraw");
    this.notice.set(null);

    this.api
      .withdraw()
      .pipe(
        switchMap((submitted) => this.answerTo(submitted)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (withdrawal) => this.settle(noticeOf(withdrawal)),
        error: () => this.settle(NO_ANSWER),
      });
  }

  protected erase(): void {
    this.busy.set("erase");
    this.notice.set(null);

    this.api
      .erase()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.settle(SCHEDULED),
        error: () => this.settle(NOT_SCHEDULED),
      });
  }

  protected cancel(): void {
    const id = this.pendingErasureId();

    if (id === null) return;

    this.busy.set("cancel");
    this.notice.set(null);

    this.api
      .cancelErasure(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.settle(CANCELLED),
        error: () => this.settle(NOT_CANCELLED),
      });
  }

  private answerTo(submitted: SubmittedWithdrawal): Observable<SubmittedWithdrawal> {
    return submitted.outcome !== null
      ? of(submitted)
      : timer(CHECK_INTERVAL_MS, CHECK_INTERVAL_MS).pipe(
          switchMap(() => this.api.find(submitted.id)),
          first((found) => found.outcome !== null),
          timeout({ first: ANSWER_WINDOW_MS }),
        );
  }

  private settle(notice: ConsentNotice): void {
    this.busy.set(null);
    this.confirming.set(null);
    this.notice.set(notice);
    this.status.reload();
  }
}
