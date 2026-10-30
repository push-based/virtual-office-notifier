import { Component } from "@angular/core";

@Component({
  selector: "hr[pbDivider]",
  template: ``,
  styles: `
    :host {
      align-self: stretch;
      margin: 0;
      border: 0;
      border-top: 1px solid var(--color-border);
    }
  `,
})
export class PbDivider {}
