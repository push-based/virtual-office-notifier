import { Component } from "@angular/core";

@Component({
  selector: "pb-card",
  template: `<ng-content />`,
  host: { class: "pb-card" },
})
export class PbCard {}
