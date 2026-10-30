import { Cause, Effect, ErrorReporter, Layer, Option } from "effect";
import { RecordingRequests } from "recording-requests/RecordingRequests";

import { ActivityLog } from "./ActivityLog.ts";
import { ActivityRecorder, RecordingDisabled } from "./ActivityRecorder.ts";
import { DatabaseConfig } from "./Config.ts";
import { Database, describeError } from "./Database.ts";
import { OfficeHistory } from "./OfficeHistory.ts";
import { RecordingStore } from "./RecordingStore.ts";
import { SlackHistory } from "./SlackHistory.ts";

const disabled = Layer.mergeAll(
  ActivityRecorder.layerDisabled,
  OfficeHistory.layerDisabled,
  SlackHistory.layerDisabled,
  RecordingStore.layerDisabled,
  RecordingRequests.layerDisabled,
);

const recordingRequests = Layer.effect(
  RecordingRequests,
  Effect.gen(function* () {
    const database = yield* Database;

    return yield* RecordingRequests.make(database.ready);
  }),
);

export const StorageLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { url } = yield* DatabaseConfig;

    return Option.match(url, {
      onNone: () =>
        disabled.pipe(
          Layer.tap(() => Effect.logInfo("DATABASE_URL isn't set, so nothing is recorded")),
        ),
      onSome: (url) =>
        Layer.mergeAll(
          ActivityRecorder.layerNoDeps,
          OfficeHistory.layer,
          SlackHistory.layer,
          RecordingStore.layer,
          recordingRequests,
        ).pipe(
          Layer.provide(Layer.provideMerge(ActivityLog.layer, Database.layer(url))),
          Layer.catch((error) =>
            disabled.pipe(
              Layer.tap(() =>
                Effect.logError("Couldn't create the database client, so nothing is recorded").pipe(
                  Effect.annotateLogs({ reason: describeError(error) }),
                  Effect.andThen(
                    ErrorReporter.report(
                      Cause.fail(new RecordingDisabled({ reason: describeError(error) })),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    });
  }),
);
