import { Component } from "@angular/core";

@Component({
  selector: "[pbDescription]",
  template: `<ng-content />`,
  styles: `
    :host {
      margin: 0;
      color: var(--color-text-muted);
    }
  `,
  host: { class: "text-body-sm" },
})
export class PbDescription {}
