import { Component, ElementRef, inject, input, model } from "@angular/core";

export interface Tab {
  readonly id: string;
  readonly label: string;
}

export type TabsAppearance = "underline" | "pills";

export const tabId = (name: string, id: string): string => `${name}-tab-${id}`;

export const tabPanelId = (name: string, id: string): string => `${name}-panel-${id}`;

const MOVES = new Map<string, (index: number, count: number) => number>([
  ["ArrowRight", (index, count) => (index + 1) % count],
  ["ArrowLeft", (index, count) => (index - 1 + count) % count],
  ["Home", () => 0],
  ["End", (_, count) => count - 1],
]);

@Component({
  selector: "pb-tabs",
  template: `
    @for (tab of tabs(); track tab.id) {
      <button
        type="button"
        role="tab"
        class="text-body-sm"
        [id]="idOf(tab)"
        [attr.aria-controls]="panelOf(tab)"
        [attr.aria-selected]="tab.id === selected()"
        [tabIndex]="tab.id === selected() ? 0 : -1"
        (click)="selected.set(tab.id)"
        (keydown)="move($event, tab)"
      >
        {{ tab.label }}
      </button>
    }
  `,
  styles: `
    :host {
      display: flex;
      gap: var(--space-1);
    }

    button {
      appearance: none;
      cursor: pointer;
      border: none;
      background: transparent;
      color: var(--color-text-muted);
      font-weight: 500;
      padding: var(--space-2) var(--space-3);
      transition:
        color 0.2s ease-out,
        background-color 0.2s ease-out,
        border-color 0.2s ease-out;
    }

    button:hover {
      color: var(--color-text-heading);
    }

    button:focus-visible {
      outline: none;
      box-shadow: var(--shadow-focus);
    }

    :host(.underline) {
      border-bottom: 1px solid var(--color-border);
    }

    :host(.underline) button {
      margin-bottom: -1px;
      border-bottom: 2px solid transparent;
    }

    :host(.underline) button[aria-selected="true"] {
      color: var(--color-brand-hover);
      border-bottom-color: var(--color-brand-hover);
    }

    :host(.pills) {
      align-self: flex-start;
      padding: var(--space-1);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-surface);
    }

    :host(.pills) button {
      border-radius: var(--radius-md);
      padding: var(--space-1) var(--space-3);
    }

    :host(.pills) button[aria-selected="true"] {
      color: var(--color-primary-700);
      background: var(--color-primary-50);
    }
  `,
  host: {
    role: "tablist",
    "[attr.aria-label]": "label()",
    "[class.underline]": "appearance() === 'underline'",
    "[class.pills]": "appearance() === 'pills'",
  },
})
export class PbTabs {
  readonly name = input.required<string>();

  readonly label = input.required<string>();

  readonly tabs = input.required<ReadonlyArray<Tab>>();

  readonly appearance = input<TabsAppearance>("underline");

  readonly selected = model.required<string>();

  private readonly element: HTMLElement = inject(ElementRef).nativeElement;

  protected idOf(tab: Tab): string {
    return tabId(this.name(), tab.id);
  }

  protected panelOf(tab: Tab): string {
    return tabPanelId(this.name(), tab.id);
  }

  protected move(event: KeyboardEvent, from: Tab): void {
    const tabs = this.tabs();
    const index = tabs.indexOf(from);

    const moveTo = MOVES.get(event.key);
    const target = moveTo === undefined ? undefined : tabs[moveTo(index, tabs.length)];

    if (target === undefined) return;

    event.preventDefault();
    this.selected.set(target.id);
    this.element.querySelector<HTMLElement>(`#${CSS.escape(this.idOf(target))}`)?.focus();
  }
}
