import { Component, inject, signal } from "@angular/core";
import { PbTabs, type Tab } from "design-system";

import { RecordingHistory } from "./history/recording-history";
import { OfficeRecorder } from "./recorder/office-recorder";
import { OfficeStore } from "./recorder/office-store";
import { OfficeStats } from "./stats/office-stats";

@Component({
  selector: "app-root",
  imports: [OfficeRecorder, OfficeStats, PbTabs, RecordingHistory],
  providers: [OfficeStore],
  template: `
    <main>
      <div class="frame">
        <nav>
          <pb-tabs name="view" label="Office Recorder" [tabs]="views" [(selected)]="view" />
        </nav>
        <div
          role="tabpanel"
          id="view-panel-now"
          aria-labelledby="view-tab-now"
          [hidden]="view() !== 'now'"
        >
          <app-office-recorder />
        </div>
        <div
          role="tabpanel"
          id="view-panel-history"
          aria-labelledby="view-tab-history"
          [hidden]="view() !== 'history'"
        >
          <app-recording-history [now]="office.now()" />
        </div>
        @if (view() === "stats") {
          <div role="tabpanel" id="view-panel-stats" aria-labelledby="view-tab-stats">
            <app-office-stats />
          </div>
        }
      </div>
    </main>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }

    main {
      min-height: 100%;
      display: grid;
      justify-items: center;
      align-content: start;
      padding: 0 var(--space-4) var(--space-8);
      background: var(--color-surface);
    }

    .frame {
      width: 100%;
      max-width: calc(var(--space-72) * 2);
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }

    nav {
      position: sticky;
      top: 0;
      z-index: 1;
      padding-top: var(--space-4);
      background: var(--color-surface);
    }
  `,
})
export class App {
  protected readonly office = inject(OfficeStore);

  protected readonly views: ReadonlyArray<Tab> = [
    { id: "now", label: "Now" },
    { id: "history", label: "History" },
    { id: "stats", label: "Stats" },
  ];

  protected readonly view = signal("now");
}
