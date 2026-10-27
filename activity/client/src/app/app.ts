import { Component } from "@angular/core";

import { OfficeRecorder } from "./recorder/office-recorder";

@Component({
  selector: "app-root",
  imports: [OfficeRecorder],
  template: `
    <main>
      <app-office-recorder />
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
      place-items: center;
      padding: var(--space-5);
      background: var(--color-surface);
    }
  `,
})
export class App {}
