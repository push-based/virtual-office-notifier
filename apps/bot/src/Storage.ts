import { Cause, Effect, ErrorReporter, Layer, Option } from "effect";
import { ConsentRequests } from "recording-requests/ConsentRequests";
import { RecordingEdits } from "recording-requests/RecordingEdits";
import { RecordingRequests } from "recording-requests/RecordingRequests";

import {
  ActivityLog,
  ActivityRecorder,
  OfficeHistory,
  RecordingDisabled,
} from "./activity/index.ts";
import { DatabaseConfig } from "./Config.ts";
import { ConsentBook, ConsentLog } from "./consent/index.ts";
import { Database, describeError } from "./database/index.ts";
import { RecordingStore } from "./recording/index.ts";
import { SlackHistory } from "./slack/index.ts";

const disabled = Layer.mergeAll(
  ActivityRecorder.layerDisabled,
  OfficeHistory.layerDisabled,
  SlackHistory.layerDisabled,
  RecordingStore.layerDisabled,
  RecordingRequests.layerDisabled,
  RecordingEdits.layerDisabled,
  ConsentRequests.layerDisabled,
  ConsentBook.layerMemory,
);

const recordingRequests = Layer.effect(
  RecordingRequests,
  Effect.gen(function* () {
    const database = yield* Database;

    return yield* RecordingRequests.make(database.ready);
  }),
);

const recordingEdits = Layer.effect(
  RecordingEdits,
  Effect.gen(function* () {
    const database = yield* Database;

    return yield* RecordingEdits.make(database.ready);
  }),
);

const consentRequests = Layer.effect(
  ConsentRequests,
  Effect.gen(function* () {
    const database = yield* Database;

    return yield* ConsentRequests.make(database.ready);
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
          recordingEdits,
          consentRequests,
          ConsentBook.layer.pipe(Layer.provide(ConsentLog.layer)),
        ).pipe(
          Layer.provide(Layer.provideMerge(ActivityLog.layer, Database.layer(url))),
          Layer.catch((error) =>
            disabled.pipe(
              Layer.tap(() =>
                Effect.logError("Couldn't create the database client, so nothing is recorded").pipe(
                  Effect.annotateLogs({ reason: describeError(error) }),
                  Effect.andThen(
                    ErrorReporter.report(
                      Cause.fail(RecordingDisabled.make({ reason: describeError(error) })),
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
