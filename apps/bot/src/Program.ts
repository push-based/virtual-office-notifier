import { Effect, Layer, Option, Redacted, Stream } from "effect";
import { SecureRandom } from "effect/crypto";

import { ActivityRecorder } from "./ActivityRecorder.ts";
import { AiProviders } from "./AiWriting.ts";
import { banter } from "./Banter.ts";
import { DiscordGateway } from "./DiscordGateway.ts";
import { OfficeEvent } from "./OfficeEvent.ts";
import { OfficeSeat } from "./OfficeSeat.ts";
import { RecordingLayer } from "./recording/index.ts";
import { reminders } from "./Reminder.ts";
import { ResponderLayer } from "./Responder.ts";
import { isRetryable, type SlackError } from "./SlackClient.ts";
import { SlackNotifier } from "./SlackNotifier.ts";
import { StorageLayer } from "./Storage.ts";

const logSlackError = (error: SlackError) =>
  (isRetryable(error.reason)
    ? Effect.logWarning("Gave up posting to Slack after retries", error.reason)
    : Effect.logError("Slack rejected the post", error.reason)
  ).pipe(Effect.annotateLogs({ outcome: "failed", reason: error.reason._tag }));

// Redacted, since a Discord user ID identifies a person.
const eventAnnotations = OfficeEvent.$match({
  Opened: ({ userId }) => ({ event: "Opened", userId: Redacted.make(userId) }),
  Emptied: ({ userId }) => ({ event: "Emptied", userId: Redacted.make(userId) }),
  Reminder: () => ({ event: "Reminder" }),
  Banter: ({ period }) => ({ event: "Banter", period }),
});

// Events are handled one at a time, so one that arrives during a retry waits
// its turn and messages stay in order.
export const program = Effect.gen(function* () {
  const gateway = yield* DiscordGateway;
  const slack = yield* SlackNotifier;
  const recorder = yield* ActivityRecorder;
  const seat = yield* OfficeSeat;

  yield* Effect.logInfo("Watching the virtual office");

  // The reminders and banter never end, so the program runs as long as the
  // Discord events do.
  const scheduled = Option.match(gateway.office, {
    onNone: () => Stream.empty,
    onSome: (office) => Stream.merge(reminders(office), banter(office)),
  });

  const events = gateway.officeEvents.pipe(Stream.merge(scheduled, { haltStrategy: "left" }));

  // Each event is its own trace, and a failed post is reported before it's
  // logged and skipped.
  const announce = Stream.runForEach(events, (event) =>
    slack.notify(event).pipe(
      Effect.withErrorReporting,
      Effect.flatMap((posted) =>
        posted
          ? Effect.logInfo("Announced office event").pipe(
              Effect.annotateLogs({ outcome: "posted" }),
            )
          : Effect.logInfo("Nothing to announce, no AI model wrote the banter").pipe(
              Effect.annotateLogs({ outcome: "skipped" }),
            ),
      ),
      Effect.catchTag("SlackError", logSlackError),
      Effect.annotateLogs(eventAnnotations(event)),
      Effect.withSpan("Program.announce", { attributes: { event: event._tag } }),
    ),
  );

  // Its own fiber, so a slow Slack post never holds up recording.
  const record = Stream.runForEach(gateway.voiceObservations, recorder.record);

  const recordEffects = Stream.runForEach(gateway.voiceEffects, recorder.recordEffect);

  const followOccupancy = Stream.runForEach(gateway.botPresence, seat.want);

  yield* Effect.all([announce, record, recordEffects, followOccupancy], {
    concurrency: "unbounded",
    discard: true,
  });
});

// Slack is built before Discord, so a missing Slack token fails before logging
// in to Discord. Recording connects to the database in the background and
// never fails startup.
export const MainLayer = Layer.mergeAll(ResponderLayer, RecordingLayer).pipe(
  Layer.provideMerge(OfficeSeat.layer),
  Layer.provideMerge(DiscordGateway.layer),
  Layer.provideMerge(SlackNotifier.layer),
  Layer.provide(AiProviders.layer),
  Layer.provideMerge(StorageLayer),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
);
