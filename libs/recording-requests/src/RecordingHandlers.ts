import { Effect, Option } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import {
  CurrentRequester,
  RecordingApi,
  RecordingNotFound,
  RequestNotFound,
} from "./RecordingApi.ts";
import { RecordingHistory } from "./RecordingHistory.ts";
import { RecordingRequests, type RecordingUnavailable } from "./RecordingRequests.ts";

const serviceUnavailable = (error: RecordingUnavailable) =>
  Effect.logWarning("Couldn't reach the recording requests").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.andThen(Effect.fail(HttpApiError.ServiceUnavailable.make({}))),
  );

export const RecordingHandlers = HttpApiBuilder.group(
  RecordingApi,
  "recording",
  Effect.fn(function* (handlers) {
    const requests = yield* RecordingRequests;

    return handlers.handleAll({
      status: () =>
        requests.status.pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
      submit: ({ payload }) =>
        Effect.gen(function* () {
          const requester = yield* CurrentRequester;

          return yield* requests.submit(requester, payload.action);
        }).pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
      find: ({ params }) =>
        Effect.gen(function* () {
          const requester = yield* CurrentRequester;
          const found = yield* requests.find(requester, params.id);

          return yield* Effect.fromOption(found).pipe(
            Effect.mapError(() => RequestNotFound.make()),
          );
        }).pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
    });
  }),
);

export const HistoryHandlers = HttpApiBuilder.group(
  RecordingApi,
  "history",
  Effect.fn(function* (handlers) {
    const history = yield* RecordingHistory;

    return handlers.handleAll({
      recordings: ({ query }) =>
        history
          .page(Option.fromUndefinedOr(query.before))
          .pipe(Effect.catchTag("RecordingUnavailable", serviceUnavailable)),
      recording: ({ params }) =>
        history.find(params.id).pipe(
          Effect.flatMap((found) =>
            Effect.fromOption(found).pipe(Effect.mapError(() => RecordingNotFound.make())),
          ),
          Effect.catchTag("RecordingUnavailable", serviceUnavailable),
        ),
    });
  }),
);
