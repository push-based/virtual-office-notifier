import { Schema } from "effect";

export const RequestCount = Schema.Struct({ sent: Schema.Finite, answered: Schema.Finite });

export type RequestCount = typeof RequestCount.Type;

export const NO_REQUESTS: RequestCount = { sent: 0, answered: 0 };

export const sendRequest = (count: RequestCount): RequestCount => ({
  ...count,
  sent: count.sent + 1,
});

export const isAwaitingAnswer = (count: RequestCount): boolean => count.sent > count.answered;

export const isNewerAnswer = (count: RequestCount, request: number): boolean =>
  request > count.answered;

export const recordAnswer = (count: RequestCount, request: number): RequestCount => ({
  ...count,
  answered: request,
});

export const ignoreSentRequests = (count: RequestCount): RequestCount => ({
  ...count,
  answered: count.sent,
});
