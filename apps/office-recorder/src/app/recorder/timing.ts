import { InjectionToken } from "@angular/core";
import { ANSWER_WINDOW_MS } from "recording-requests/wire";

export interface RecorderTiming {
  readonly statePollMs: number;
  readonly clockTickMs: number;
  readonly requestPollMs: number;
  readonly requestPollLimit: number;
  readonly noticeMs: number;
}

const REQUEST_POLL_MS = 1000;

export const RECORDER_TIMING = new InjectionToken<RecorderTiming>("RecorderTiming", {
  providedIn: "root",
  factory: () => ({
    statePollMs: 3000,
    clockTickMs: 1000,
    requestPollMs: REQUEST_POLL_MS,
    requestPollLimit: Math.ceil(ANSWER_WINDOW_MS / REQUEST_POLL_MS),
    noticeMs: 6000,
  }),
});
