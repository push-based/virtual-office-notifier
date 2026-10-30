import { InjectionToken } from "@angular/core";

export interface HistoryTiming {
  readonly listPollMs: number;
  readonly recordingPollMs: number;
}

export const HISTORY_TIMING = new InjectionToken<HistoryTiming>("HistoryTiming", {
  providedIn: "root",
  factory: () => ({ listPollMs: 15_000, recordingPollMs: 5000 }),
});
