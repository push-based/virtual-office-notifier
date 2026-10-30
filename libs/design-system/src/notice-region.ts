import { Component } from "@angular/core";

@Component({
  selector: "pb-notice-region",
  template: `<ng-content />`,
  styles: `
    :host {
      display: contents;
    }
  `,
  host: { role: "status" },
})
export class PbNoticeRegion {}
