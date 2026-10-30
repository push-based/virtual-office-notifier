import { Component, computed, inject, signal } from "@angular/core";
import { rxResource } from "@angular/core/rxjs-interop";
import {
  PbBarList,
  PbButton,
  PbCard,
  PbDescription,
  PbEyebrow,
  PbHeatmap,
  PbNotice,
  PbStat,
  PbTabs,
  tabId,
  tabPanelId,
} from "design-system";

import { RecorderSession } from "../recorder/session";
import { describeStats, RANGES, rangeOf } from "./describe-stats";
import { StatsApi } from "./stats-api";

@Component({
  selector: "app-office-stats",
  imports: [
    PbBarList,
    PbButton,
    PbCard,
    PbDescription,
    PbEyebrow,
    PbHeatmap,
    PbNotice,
    PbStat,
    PbTabs,
  ],
  template: `
    <pb-card size="lg">
      <p pbEyebrow>Office stats</p>
      <pb-tabs
        name="range"
        label="Range"
        appearance="pills"
        [tabs]="ranges"
        [(selected)]="selected"
      />
      <div
        class="panel"
        role="tabpanel"
        [id]="panelId()"
        [attr.aria-labelledby]="labelId()"
        [attr.aria-busy]="stats.isLoading()"
      >
        @if (stats.error(); as error) {
          <pb-notice kind="error">Couldn't count the stats: {{ error.message }}</pb-notice>
          <button
            pbButton
            type="button"
            variant="ghost"
            class="retry"
            [disabled]="stats.isLoading()"
            (click)="stats.reload()"
          >
            {{ stats.isLoading() ? "Counting…" : "Try again" }}
          </button>
        } @else if (view(); as view) {
          <div class="pair">
            <pb-stat [value]="view.recordings" label="Recordings" />
            <pb-stat [value]="view.recorded" label="Recorded" />
          </div>
          <pb-bar-list
            label="Time in the office"
            [items]="view.timeInOffice"
            empty="Nobody was in"
          />
          <div class="pair">
            <pb-bar-list label="First in" [items]="view.firstIn" empty="Nobody arrived" />
            <pb-bar-list label="Last out" [items]="view.lastOut" empty="Nobody left" />
          </div>
          <pb-heatmap
            label="Busiest hours · UTC+2"
            [columns]="view.busiest.columns"
            [rows]="view.busiest.rows"
            empty="Nobody was in"
          />
          <div class="pair">
            <pb-bar-list
              label="Most played sounds"
              [items]="view.sounds"
              empty="No sounds played"
            />
            <pb-bar-list
              label="Who plays the most"
              [items]="view.players"
              empty="No sounds played"
            />
          </div>
          <pb-bar-list label="Top reactions" [items]="view.reactions" empty="No reactions" />
        } @else {
          <p pbDescription>Counting…</p>
        }
      </div>
    </pb-card>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
    }

    .panel {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }

    .retry {
      align-self: flex-start;
    }

    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(var(--space-48), 1fr));
      gap: var(--space-4) var(--space-6);
    }
  `,
})
export class OfficeStats {
  private readonly api = inject(StatsApi);

  private readonly session = inject(RecorderSession);

  protected readonly ranges = RANGES;

  protected readonly selected = signal<string>("week");

  private readonly range = computed(() => rangeOf(this.selected()));

  protected readonly panelId = computed(() => tabPanelId("range", this.range()));

  protected readonly labelId = computed(() => tabId("range", this.range()));

  protected readonly stats = rxResource({
    params: () => (this.session.token() === null ? undefined : this.range()),
    stream: ({ params }) => this.api.stats(params),
  });

  protected readonly view = computed(() => {
    const stats = this.stats.value();

    return stats === undefined ? null : describeStats(stats);
  });
}
