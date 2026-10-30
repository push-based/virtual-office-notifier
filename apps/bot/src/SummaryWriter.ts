import { NodeHttpClient } from "@effect/platform-node";
import {
  Array,
  Cause,
  Context,
  DateTime,
  Effect,
  ErrorReporter,
  identity,
  Layer,
  type LogLevel,
  Option,
  Order,
  pipe,
  Schema,
  SchemaTransformation,
  String,
} from "effect";

import {
  configuredProviders,
  failureReason,
  type Providers,
  writeWithProviders,
} from "./AiWriting.ts";
import { officeClock } from "./Banter.ts";
import type { ClipLine, PauseLine, RecordingDetails } from "./RecordingStore.ts";
import { formatDuration } from "./SlackMessage.ts";

export const MAX_SUMMARY_LENGTH = 1500;

export const SummaryText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_SUMMARY_LENGTH),
      Schema.isPattern(/^[^<>]+$/s),
    ),
    SchemaTransformation.transform({
      decode: (text) =>
        pipe(text, String.trim, String.replace(/^["'“]+|["'”]+$/g, ""), String.trim),
      encode: identity,
    }),
  ),
);

export class NoAiSummary extends Schema.TaggedError<
  NoAiSummary,
  { readonly brand: unique symbol }
>()("NoAiSummary", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `No AI model could summarize the recording, the last failed with ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

export interface WrittenSummary {
  readonly text: string;
  readonly model: string;
}

const SUMMARY_PROMPT = Array.join(
  [
    "You summarize a recorded conversation from a team's virtual office, a Discord voice channel where people work alongside each other. The transcript was made by speech recognition, one line per stretch of speech, each with the time in UTC+2 and who spoke.",
    "Write a summary for the team's Slack channel: what was discussed, any decisions, and any action items with the name of whoever took them. Leave out small talk unless it's the whole conversation.",
    "A line like '14:20–14:35 Paused by Ben' marks a pause: nothing was recorded in that stretch, so don't join what was said before and after it into one topic, and don't guess what was said during it.",
    "Only say what the transcript shows. Speech recognition gets words wrong, so when a line makes no sense, skip it rather than guess.",
    "Name people exactly as they're written in the transcript. Refer to people by name or as they, never as he or she.",
    "Reply with plain text only: short lines starting with •, no headings, no markdown, no quotes, no labels, nothing in angle brackets. Keep the whole reply under 1,200 characters.",
  ],
  "\n",
);

const clock = (at: DateTime.Utc): string => pipe(officeClock(at), String.slice(-5));

interface TimedLine {
  readonly at: DateTime.Utc;
  readonly text: string;
}

const byTime = Order.mapInput(DateTime.Order, (line: TimedLine) => line.at);

const spokenLines = (lines: ReadonlyArray<ClipLine>): ReadonlyArray<TimedLine> =>
  Array.flatMap(lines, ({ startedAt, who, transcription, transcript }) => {
    if (transcription === "done") {
      const text = String.trim(transcript ?? "");

      return text === "" ? [] : [{ at: startedAt, text: `${clock(startedAt)} ${who}: ${text}` }];
    }

    return transcription === "failed"
      ? [{ at: startedAt, text: `${clock(startedAt)} ${who}: [couldn't be transcribed]` }]
      : [];
  });

export const transcriptLines = (lines: ReadonlyArray<ClipLine>): ReadonlyArray<string> =>
  Array.map(spokenLines(lines), ({ text }) => text);

export const pauseMarker = (pause: PauseLine, stoppedAt: DateTime.Utc): string =>
  `${clock(pause.pausedAt)}–${clock(pause.resumedAt ?? stoppedAt)} Paused by ${pause.who}`;

export const transcriptText = (
  details: RecordingDetails,
  lines: ReadonlyArray<ClipLine>,
  pauses: ReadonlyArray<PauseLine>,
): string =>
  Array.join(
    [
      `Office recording from ${officeClock(details.startedAt)} to ${clock(details.stoppedAt)} (UTC+2), ${formatDuration(DateTime.distance(details.startedAt, details.stoppedAt))}, started by ${details.startedByName}.`,
      "",
      ...pipe(
        Array.appendAll(
          spokenLines(lines),
          Array.map(pauses, (pause) => ({
            at: pause.pausedAt,
            text: pauseMarker(pause, details.stoppedAt),
          })),
        ),
        Array.sort(byTime),
        Array.map(({ text }) => text),
      ),
    ],
    "\n",
  );

export const speakersOf = (lines: ReadonlyArray<ClipLine>): ReadonlyArray<string> =>
  pipe(
    lines,
    Array.flatMap((line) => (line.transcription === "done" ? [line.who] : [])),
    Array.dedupe,
  );

export const hasSpeech = (lines: ReadonlyArray<ClipLine>): boolean =>
  transcriptLines(lines).length > 0;

export class SummaryWriter extends Context.Service<
  SummaryWriter,
  {
    write(transcript: string): Effect.Effect<Option.Option<WrittenSummary>>;
  }
>()("bot/SummaryWriter") {
  static readonly layerProviders = (providers: Providers) =>
    Layer.succeed(
      SummaryWriter,
      SummaryWriter.of({
        write: Effect.fn("SummaryWriter.write")(
          function* (transcript: string) {
            const { value, model } = yield* writeWithProviders(
              { prompt: SUMMARY_PROMPT, request: transcript, reply: SummaryText },
              providers,
            );

            return { text: value, model };
          },
          Effect.tapError((error) =>
            Effect.logWarning("No AI model could summarize the recording").pipe(
              Effect.andThen(
                ErrorReporter.report(
                  Cause.fail(NoAiSummary.make({ reason: failureReason(error) })),
                ),
              ),
            ),
          ),
          Effect.option,
        ),
      }),
    );

  static readonly layerNone = Layer.succeed(
    SummaryWriter,
    SummaryWriter.of({ write: () => Effect.succeedNone }),
  );

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const providers = yield* configuredProviders((config) => config.openRouter.banterModels);

      return Array.match(providers, {
        onEmpty: () =>
          Layer.effectDiscard(
            Effect.logInfo("No AI provider configured, so recordings get no summary"),
          ).pipe(Layer.provideMerge(SummaryWriter.layerNone)),
        onNonEmpty: SummaryWriter.layerProviders,
      });
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
}
