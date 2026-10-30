import { Component } from "@angular/core";

@Component({
  selector: "[pbHeading]",
  template: `<ng-content />`,
  styles: `
    :host {
      margin: 0;
      color: var(--color-text-heading);
    }
  `,
  host: { class: "text-section-title" },
})
export class PbHeading {}
