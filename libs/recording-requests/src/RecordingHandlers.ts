import { Effect, Option } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import {
  CurrentRequester,
  EditNotFound,
  RecordingApi,
  RecordingNotFound,
  RequestNotFound,
} from "./RecordingApi.ts";
import { RecordingEdits } from "./RecordingEdits.ts";
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
      submit: Effect.fnUntraced(
        function* ({ payload }) {
          const requester = yield* CurrentRequester;

          return yield* requests.submit(requester, payload.action, {
            title: payload.title ?? null,
            agenda: payload.agenda ?? null,
            summaryStyle: payload.summaryStyle ?? null,
          });
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      find: Effect.fnUntraced(
        function* ({ params }) {
          const requester = yield* CurrentRequester;
          const found = yield* requests.find(requester, params.id);

          return yield* Effect.fromOption(found).pipe(
            Effect.mapError(() => RequestNotFound.make()),
          );
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
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

export const EditHandlers = HttpApiBuilder.group(
  RecordingApi,
  "edits",
  Effect.fn(function* (handlers) {
    const edits = yield* RecordingEdits;

    return handlers.handleAll({
      submit: Effect.fnUntraced(
        function* ({ params, payload }) {
          const editor = yield* CurrentRequester;
          const submitted = yield* edits.submit(editor, params.id, payload);

          return yield* Effect.fromOption(submitted).pipe(
            Effect.mapError(() => RecordingNotFound.make()),
          );
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      find: Effect.fnUntraced(
        function* ({ params }) {
          const editor = yield* CurrentRequester;
          const found = yield* edits.find(editor, params.id);

          return yield* Effect.fromOption(found).pipe(Effect.mapError(() => EditNotFound.make()));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
    });
  }),
);
