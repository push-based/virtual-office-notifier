import { Effect } from "effect";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";

import { OfficeStatsReader, type StatsUnavailable } from "./OfficeStats.ts";
import { RecordingApi } from "./RecordingApi.ts";

const serviceUnavailable = (error: StatsUnavailable) =>
  Effect.logWarning("Couldn't read the office stats").pipe(
    Effect.annotateLogs({ reason: error.reason }),
    Effect.andThen(Effect.fail(HttpApiError.ServiceUnavailable.make({}))),
  );

export const StatsHandlers = HttpApiBuilder.group(
  RecordingApi,
  "stats",
  Effect.fn(function* (handlers) {
    const reader = yield* OfficeStatsReader;

    return handlers.handle("office", ({ query }) =>
      reader.stats(query.range).pipe(Effect.catchTag("StatsUnavailable", serviceUnavailable)),
    );
  }),
);
