import { Effect } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import { CurrentRequester, RecordingApi, RequestNotFound } from "./RecordingApi.ts";
import { RecordingRequests, type RecordingUnavailable } from "./RecordingRequests.ts";

const serviceUnavailable = (error: RecordingUnavailable) =>
  Effect.logWarning("Couldn't reach the recording requests").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.andThen(Effect.fail(new HttpApiError.ServiceUnavailable({}))),
  );

export const RecordingHandlers = HttpApiBuilder.group(
  RecordingApi,
  "recording",
  Effect.fn(function* (handlers) {
    const requests = yield* RecordingRequests;

    return handlers.handleAll({
      status: () => requests.status.pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
      submit: ({ payload }) =>
        Effect.gen(function* () {
          const requester = yield* CurrentRequester;

          return yield* requests.submit(requester, payload.action);
        }).pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
      find: ({ params }) =>
        Effect.gen(function* () {
          const requester = yield* CurrentRequester;
          const found = yield* requests.find(requester, params.id);

          return yield* Effect.fromOption(found).pipe(Effect.mapError(() => new RequestNotFound()));
        }).pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
    });
  }),
);
