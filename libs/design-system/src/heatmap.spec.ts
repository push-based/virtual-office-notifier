import { Component, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vite-plus/test";

import { type HeatmapRow, PbHeatmap } from "./heatmap";

@Component({
  imports: [PbHeatmap],
  template: `<pb-heatmap label="Busiest hours" [columns]="columns" [rows]="rows()" />`,
})
class Host {
  readonly columns = ["9", "10"];

  readonly rows = signal<ReadonlyArray<HeatmapRow>>([
    {
      label: "Mon",
      cells: [
        { value: 1, description: "Mon 9:00, 1 person" },
        { value: 2, description: "Mon 10:00, 2 people" },
      ],
    },
    {
      label: "Tue",
      cells: [
        { value: 0, description: "Tue 9:00, nobody" },
        { value: null, description: "Tue 10:00, not yet" },
      ],
    },
  ]);
}

describe("PbHeatmap", () => {
  it("shades each cell relative to the busiest one and describes it", async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;
    const cells = [...element.querySelectorAll<HTMLElement>("tbody td")];

    expect([...element.querySelectorAll("th[scope=col]")].map((th) => th.textContent)).toEqual([
      "9",
      "10",
    ]);
    expect([...element.querySelectorAll("th[scope=row]")].map((th) => th.textContent)).toEqual([
      "Mon",
      "Tue",
    ]);
    expect(cells.map((cell) => cell.style.getPropertyValue("--heat"))).toEqual([
      "0.5",
      "1",
      "0",
      "0",
    ]);
    expect(cells.map((cell) => cell.classList.contains("unknown"))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(cells[1]?.getAttribute("title")).toBe("Mon 10:00, 2 people");
    expect(cells[1]?.textContent?.trim()).toBe("Mon 10:00, 2 people");
  });

  it("says so when there's nothing to show", async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.rows.set([]);
    await fixture.whenStable();
    const element: HTMLElement = fixture.nativeElement;

    expect(element.querySelector("table")).toBeNull();
    expect(element.textContent).toContain("Nothing yet");
  });
});
