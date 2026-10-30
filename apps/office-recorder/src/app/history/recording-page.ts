import { Component, computed, input, output } from "@angular/core";
import {
  PbAvatar,
  PbBadge,
  PbButton,
  PbDescription,
  PbDivider,
  PbEyebrow,
  PbHeading,
  PbPeople,
} from "design-system";

import { ActionItems } from "../edits/action-items";
import { RecordingEditor } from "../edits/recording-editor";
import { SummaryRewrite } from "../edits/summary-rewrite";
import {
  describeStop,
  formatClock,
  formatOfficeTime,
  formatRunTime,
  isLive,
  NO_SUMMARY,
  stateBadge,
  summaryCredit,
  transcriptTurns,
} from "./describe-recording";
import type { RecordingDetail } from "./models";
import { personOf } from "./recording-row";

@Component({
  selector: "app-recording-page",
  imports: [
    ActionItems,
    PbAvatar,
    PbBadge,
    PbButton,
    PbDescription,
    PbDivider,
    PbEyebrow,
    PbHeading,
    PbPeople,
    RecordingEditor,
    SummaryRewrite,
  ],
  template: `
    <button pbButton variant="tertiary" type="button" class="back" (click)="back.emit()">
      ← Back
    </button>
    <header>
      <div class="top">
        <h2 pbHeading>{{ recording().title ?? startedAt() }}</h2>
        <pb-badge [tone]="badge().tone">{{ badge().label }}</pb-badge>
      </div>
      <p pbDescription>{{ facts() }}</p>
      @if (speakers().length > 0) {
        <pb-people [people]="speakers()" label="Who spoke" />
      }
      @if (recording().agenda; as agenda) {
        <section class="agenda" aria-labelledby="agenda-heading">
          <p pbEyebrow tone="muted" id="agenda-heading">Agenda</p>
          <p class="text-body agenda-text">{{ agenda }}</p>
        </section>
      }
      <app-recording-editor
        [recordingId]="recording().id"
        [currentTitle]="recording().title"
        [currentAgenda]="recording().agenda"
        [currentSummaryStyle]="recording().summaryStyle"
        (saved)="edited.emit()"
      />
    </header>
    @if (recording().state === "finished") {
      <hr pbDivider />
      <section aria-labelledby="summary-heading">
        <p pbEyebrow tone="muted" id="summary-heading">Summary</p>
        <p class="text-body summary">{{ recording().summary ?? noSummary }}</p>
        @if (recording().rewriting) {
          <p class="text-caption footer" role="status">Rewriting…</p>
        } @else if (credit(); as credit) {
          <p class="text-caption footer">{{ credit }}</p>
        }
        <app-summary-rewrite
          [recordingId]="recording().id"
          [rewriting]="recording().rewriting"
          (saved)="edited.emit()"
        />
      </section>
      <app-action-items
        [recordingId]="recording().id"
        [items]="recording().actionItems"
        [members]="recording().members"
        (saved)="edited.emit()"
      />
    }
    @if (recording().slackPermalink; as link) {
      <button pbButton variant="ghost" type="button" (click)="openInSlack.emit(link)">
        Open in Slack
      </button>
    }
    <hr pbDivider />
    <section aria-labelledby="transcript-heading">
      <p pbEyebrow tone="muted" id="transcript-heading">Transcript</p>
      <ol class="transcript">
        @for (turn of turns(); track turn.startedAt + turn.speaker.userId) {
          <li class="turn">
            <pb-avatar [name]="turn.speaker.name" [src]="turn.speaker.avatarUrl" />
            <div class="said">
              <p class="text-body-sm who">
                <span class="name">{{ turn.speaker.name }}</span>
                <span class="text-caption time">{{ clock(turn.startedAt) }}</span>
              </p>
              @for (line of turn.lines; track $index) {
                <p class="text-body line">{{ line }}</p>
              }
            </div>
          </li>
        } @empty {
          <li pbDescription>Nothing transcribed yet.</li>
        }
      </ol>
      @if (live()) {
        <p pbDescription class="more">More on the way…</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .back {
      align-self: flex-start;
    }

    header,
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }

    .summary,
    .line,
    .agenda-text {
      margin: 0;
      white-space: pre-line;
    }

    h2 {
      overflow-wrap: anywhere;
    }

    .footer {
      margin: 0;
      color: var(--color-text-muted);
    }

    .transcript {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }

    .turn {
      display: flex;
      gap: var(--space-3);
      align-items: flex-start;
    }

    pb-avatar {
      flex: none;
    }

    .said {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      min-width: 0;
    }

    .who {
      margin: 0;
      display: flex;
      gap: var(--space-2);
      align-items: baseline;
    }

    .name {
      font-weight: 600;
      color: var(--color-text-heading);
    }

    .time {
      color: var(--color-text-muted);
    }
  `,
})
export class RecordingPage {
  readonly recording = input.required<RecordingDetail>();

  readonly now = input.required<number>();

  readonly back = output();

  readonly openInSlack = output<string>();

  readonly edited = output();

  protected readonly noSummary = NO_SUMMARY;

  protected readonly clock = formatClock;

  protected readonly badge = computed(() => stateBadge(this.recording().state));

  protected readonly live = computed(() => isLive(this.recording().state));

  protected readonly credit = computed(() => summaryCredit(this.recording()));

  protected readonly startedAt = computed(() => formatOfficeTime(this.recording().startedAt));

  protected readonly facts = computed(() => {
    const recording = this.recording();

    return [
      ...(recording.title === null ? [] : [this.startedAt()]),
      formatRunTime(recording.startedAt, recording.stoppedAt, this.now()),
      `Started by ${recording.startedBy.name}`,
      describeStop(recording),
    ]
      .filter((fact) => fact !== null)
      .join(" · ");
  });

  protected readonly speakers = computed(() => this.recording().speakers.map(personOf));

  protected readonly turns = computed(() => transcriptTurns(this.recording().clips));
}
