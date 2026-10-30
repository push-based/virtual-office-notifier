import { Component, input } from "@angular/core";
import { ElapsedPipe, PbDescription, PbHeading, PbLiveDot, TimeLeftPipe } from "design-system";

import type { OfficePhase } from "../models";

@Component({
  selector: "app-status-heading",
  imports: [ElapsedPipe, PbDescription, PbHeading, PbLiveDot, TimeLeftPipe],
  template: `
    @let current = phase();
    <h1 pbHeading class="text-tabular">
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
          <pb-live-dot />
          Recording · {{ current.recording.startedAt | elapsed: now() }}
        }
      }
    </h1>
    <p pbDescription>
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
          Started by {{ current.recording.startedByName }} ·
          {{ current.recording.endsAt | timeLeft: now() }} left
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

    pb-live-dot {
      margin-right: var(--space-2-5);
    }
  `,
})
export class StatusHeading {
  readonly phase = input.required<OfficePhase>();

  readonly now = input.required<number>();
}
