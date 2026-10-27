import { Component } from "@angular/core";

@Component({
  selector: "ul[pbAvatarGroup]",
  template: `<ng-content />`,
  styles: `
    :host {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
  `,
})
export class PbAvatarGroup {}
