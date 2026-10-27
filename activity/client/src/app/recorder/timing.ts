import { InjectionToken } from "@angular/core";

export interface RecorderTiming {
  readonly statePollMs: number;
  readonly clockTickMs: number;
  readonly requestPollMs: number;
  readonly requestPollLimit: number;
  readonly noticeMs: number;
}

export const RECORDER_TIMING = new InjectionToken<RecorderTiming>("RecorderTiming", {
  providedIn: "root",
  factory: () => ({
    statePollMs: 3000,
    clockTickMs: 1000,
    requestPollMs: 1000,
    requestPollLimit: 15,
    noticeMs: 6000,
  }),
});
