import { Effect, Option } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import { ConsentRequests } from "./ConsentRequests.ts";
import {
  CurrentRequester,
  ErasureNotFound,
  NotAnAdmin,
  RecordingApi,
  WithdrawalNotFound,
} from "./RecordingApi.ts";
import type { RecordingUnavailable } from "./RecordingRequests.ts";

const serviceUnavailable = (error: RecordingUnavailable) =>
  Effect.logWarning("Couldn't reach the consent records").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.andThen(Effect.fail(HttpApiError.ServiceUnavailable.make({}))),
  );

const orErasureNotFound = <A>(found: Option.Option<A>) =>
  Effect.fromOption(found).pipe(Effect.mapError(() => ErasureNotFound.make()));

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

          return yield* orErasureNotFound(yield* consent.findErasure(requester.id, params.id));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      cancelErasure: Effect.fnUntraced(
        function* ({ params }) {
          const requester = yield* CurrentRequester;

          return yield* orErasureNotFound(yield* consent.cancelErasure(requester.id, params.id));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
    });
  }),
);

const asAdmin = Effect.fnUntraced(function* (consent: ConsentRequests["Service"]) {
  const requester = yield* CurrentRequester;
  const admin = yield* consent.adminOf("discord", requester.id);

  if (Option.isNone(admin)) return yield* NotAnAdmin.make();

  return requester;
});

export const ErasureAdminHandlers = HttpApiBuilder.group(
  RecordingApi,
  "erasureAdmin",
  Effect.fn(function* (handlers) {
    const consent = yield* ConsentRequests;

    return handlers.handleAll({
      cases: Effect.fnUntraced(
        function* () {
          yield* asAdmin(consent);

          return yield* consent.cases;
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      expedite: Effect.fnUntraced(
        function* ({ params }) {
          const admin = yield* asAdmin(consent);

          return yield* orErasureNotFound(yield* consent.expedite(params.id, admin.id));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      seen: Effect.fnUntraced(
        function* ({ params }) {
          const admin = yield* asAdmin(consent);

          return yield* orErasureNotFound(yield* consent.seen(params.id, admin.id));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
      refuse: Effect.fnUntraced(
        function* ({ params, payload }) {
          const admin = yield* asAdmin(consent);

          return yield* orErasureNotFound(yield* consent.refuse(params.id, admin.id, payload));
        },
        Effect.catchTag("RecordingUnavailable", serviceUnavailable),
      ),
    });
  }),
);
