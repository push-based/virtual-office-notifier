import { Component, signal } from "@angular/core";
import { PbTabs, type Tab } from "design-system";

import { OfficeRecorder } from "./recorder/office-recorder";
import { OfficeStats } from "./stats/office-stats";

@Component({
  selector: "app-root",
  imports: [OfficeRecorder, OfficeStats, PbTabs],
  template: `
    <main>
      <div class="frame">
        <pb-tabs name="view" label="Office Recorder" [tabs]="views" [(selected)]="view" />
        <div
          class="now"
          role="tabpanel"
          id="view-panel-now"
          aria-labelledby="view-tab-now"
          [hidden]="view() !== 'now'"
        >
          <app-office-recorder />
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
      padding: var(--space-5);
      background: var(--color-surface);
    }

    .frame {
      width: 100%;
      max-width: calc(var(--space-96) * 2);
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
    }

    .now:not([hidden]) {
      display: grid;
      justify-items: center;
    }
  `,
})
export class App {
  protected readonly views: ReadonlyArray<Tab> = [
    { id: "now", label: "Now" },
    { id: "stats", label: "Stats" },
  ];

  protected readonly view = signal("now");
}
