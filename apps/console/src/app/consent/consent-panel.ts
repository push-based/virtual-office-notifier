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
  RECORDED_IN_THE_OFFICE,
  type SubmittedWithdrawal,
} from "recording-requests/wire";
import { type Observable, first, of, switchMap, timeout, timer } from "rxjs";

import { RecorderSession } from "../recorder/session";
import { ConsentApi } from "./consent-api";
import { describeConsent } from "./describe-consent";

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

const noticeOf = (withdrawal: SubmittedWithdrawal): ConsentNotice =>
  withdrawal.outcome === "ignored" ? NOTHING_TO_WITHDRAW : WITHDRAWN;

@Component({
  selector: "app-consent-panel",
  imports: [PbButton, PbCard, PbDescription, PbEyebrow, PbNotice, PbNoticeRegion, PbStatusHeading],
  template: `
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
        <pb-status-heading [heading]="view.heading" [description]="view.description" [level]="2" />
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
        @if (view.canWithdraw) {
          @if (confirming()) {
            <div class="confirm" role="group" aria-labelledby="confirm-text">
              <p id="confirm-text" class="text-body-sm">
                Withdrawing shows you out of the office straight away, and nothing new is recorded
                about you. What's already recorded stays until you ask for it to be deleted. If you
                come back, the bot will ask you again.
              </p>
              <div class="controls">
                <button
                  pbButton
                  type="button"
                  [disabled]="busy()"
                  [attr.aria-busy]="busy()"
                  (click)="withdraw()"
                >
                  {{ busy() ? "Withdrawing…" : "Withdraw my consent" }}
                </button>
                <button
                  pbButton
                  type="button"
                  variant="ghost"
                  [disabled]="busy()"
                  (click)="confirming.set(false)"
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
              (click)="confirming.set(true)"
            >
              Withdraw consent
            </button>
          }
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
  `,
  styles: `
    :host {
      display: block;
    }

    .align-start {
      align-self: flex-start;
    }

    .recorded {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
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

  protected readonly confirming = signal(false);

  protected readonly busy = signal(false);

  protected readonly notice = signal<ConsentNotice | null>(null);

  protected readonly status = rxResource({
    params: () => (this.session.token() === null ? undefined : this.session.token()),
    stream: () => this.api.status(),
  });

  protected readonly view = computed(() => {
    const status = this.status.value();

    return status === undefined ? null : describeConsent(status);
  });

  protected withdraw(): void {
    this.busy.set(true);
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
    this.busy.set(false);
    this.confirming.set(false);
    this.notice.set(notice);
    this.status.reload();
  }
}
