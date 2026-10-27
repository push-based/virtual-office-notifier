import { Component, input } from "@angular/core";

import { ElapsedPipe } from "../elapsed.pipe";
import type { OfficePhase } from "../models";
import { TimeLeftPipe } from "../time-left.pipe";

@Component({
  selector: "app-status-heading",
  imports: [ElapsedPipe, TimeLeftPipe],
  template: `
    @let current = phase();
    <h1 class="text-section-title headline">
      @switch (current.kind) {
        @case ("failed") {
          Couldn't start
        }
        @case ("connecting") {
          Connecting…
        }
        @case ("away") {
          The bot isn't in the office yet
        }
        @case ("idle") {
          Not recording
        }
        @case ("recording") {
          <span class="live" aria-hidden="true"></span>
          Recording · {{ current.recording.startedAt | elapsed: now() }}
        }
      }
    </h1>
    <p class="text-body-sm detail">
      @switch (current.kind) {
        @case ("failed") {
          {{ current.reason }}
        }
        @case ("connecting") {
          Hold on a moment.
        }
        @case ("away") {
          It joins once someone is in the voice channel.
        }
        @case ("idle") {
          Press start to record and transcribe the office.
        }
        @case ("recording") {
          Started by {{ current.recording.startedByName }} · {{ current.recording.endsAt | timeLeft: now() }}
        }
      }
    </p>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .headline {
      margin: 0;
      color: var(--color-text-heading);
      font-variant-numeric: tabular-nums;
    }

    .live {
      display: inline-block;
      vertical-align: middle;
      margin-right: var(--space-2-5);
      width: var(--space-3);
      height: var(--space-3);
      border-radius: var(--radius-full);
      background: var(--color-error-500);
      animation: pulse 1.6s ease-out infinite;
    }

    .detail {
      margin: 0;
      color: var(--color-text-muted);
    }

    @keyframes pulse {
      0% {
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-error-500) 50%, transparent);
      }
      100% {
        box-shadow: 0 0 0 var(--space-2) transparent;
      }
    }
  `,
})
export class StatusHeading {
  readonly phase = input.required<OfficePhase>();

  readonly now = input.required<number>();
}
