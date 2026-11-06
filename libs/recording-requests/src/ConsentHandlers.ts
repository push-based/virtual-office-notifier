import { Effect } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import { ConsentRequests } from "./ConsentRequests.ts";
import {
  CurrentRequester,
  ErasureNotFound,
  RecordingApi,
  WithdrawalNotFound,
} from "./RecordingApi.ts";
import type { RecordingUnavailable } from "./RecordingRequests.ts";

const serviceUnavailable = (error: RecordingUnavailable) =>
  Effect.logWarning("Couldn't reach the consent records").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.andThen(Effect.fail(HttpApiError.ServiceUnavailable.make({}))),
  );

export const ConsentHandlers = HttpApiBuilder.group(
  RecordingApi,
  "consent",
  Effect.fn(function* (handlers) {
    const consent = yield* ConsentRequests;

    return handlers.handleAll({
      status: Effect.fnUntraced(
        function* () {
          const requester = yield* CurrentRequester;

          return yield* consent.status(requester.id);
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      withdraw: Effect.fnUntraced(
        function* () {
          const requester = yield* CurrentRequester;

          return yield* consent.withdraw(requester.id);
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      find: Effect.fnUntraced(
        function* ({ params }) {
          const requester = yield* CurrentRequester;
          const found = yield* consent.find(requester.id, params.id);

          return yield* Effect.fromOption(found).pipe(
            Effect.mapError(() => WithdrawalNotFound.make()),
          );
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      erase: Effect.fnUntraced(
        function* () {
          const requester = yield* CurrentRequester;

          return yield* consent.erase(requester.id);
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      findErasure: Effect.fnUntraced(
        function* ({ params }) {
          const requester = yield* CurrentRequester;
          const found = yield* consent.findErasure(requester.id, params.id);

          return yield* Effect.fromOption(found).pipe(
            Effect.mapError(() => ErasureNotFound.make()),
          );
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
    });
  }),
);
