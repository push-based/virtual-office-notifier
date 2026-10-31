import { Array, Context, Effect, Layer, Option } from "effect";

import {
  ACTION_ITEMS_PROMPT,
  ActionItemsReply,
  actionItemsRequest,
  type Member,
  NoAiActionItems,
  ownedBy,
  type PulledActionItems,
} from "./ActionItems.ts";
import { orReportedNone, type Providers, writerLayer, writeWithProviders } from "../ai/index.ts";
import type { ClipLine, PauseLine, RecordingDetails } from "./RecordingStore.ts";
import {
  NoAiSummary,
  STYLE_BRIEFS,
  summaryRequest,
  transcriptText,
  type WrittenSummary,
} from "./SummaryWriter.ts";

export interface RecordingToWrite {
  readonly details: RecordingDetails;
  readonly lines: ReadonlyArray<ClipLine>;
  readonly pauses: ReadonlyArray<PauseLine>;
}

export const summaryRequestOf = ({ details, lines, pauses }: RecordingToWrite): string =>
  summaryRequest(details, transcriptText(details, lines, pauses));

export const actionItemsRequestOf = (
  recording: RecordingToWrite,
  attendees: ReadonlyArray<Member>,
): string => actionItemsRequest(attendees, summaryRequestOf(recording));

export class RecordingWriter extends Context.Service<
  RecordingWriter,
  {
    summarize(recording: RecordingToWrite): Effect.Effect<Option.Option<WrittenSummary>>;
    pullActionItems(
      recording: RecordingToWrite,
      attendees: ReadonlyArray<Member>,
    ): Effect.Effect<Option.Option<PulledActionItems>>;
  }
>()("bot/recording/RecordingWriter") {
  static readonly layerProviders = (providers: Providers) =>
    Layer.succeed(
      RecordingWriter,
      RecordingWriter.of({
        summarize: Effect.fn("RecordingWriter.summarize")(
          function* (recording: RecordingToWrite) {
            const { summaryStyle: style } = recording.details;

            const { value, model } = yield* writeWithProviders(
              { ...STYLE_BRIEFS[style], request: summaryRequestOf(recording) },
              providers,
            );

            return { text: value, model, style };
          },
          orReportedNone("summarize the recording", (reason) => NoAiSummary.make({ reason })),
        ),
        pullActionItems: Effect.fn("RecordingWriter.pullActionItems")(
          function* (recording: RecordingToWrite, attendees: ReadonlyArray<Member>) {
            const { value, model } = yield* writeWithProviders(
              {
                prompt: ACTION_ITEMS_PROMPT,
                request: actionItemsRequestOf(recording, attendees),
                reply: ActionItemsReply,
              },
              providers,
            );

            const pulled = Array.map(value, ({ text, owner }) => ({
              text,
              ownerName: owner ?? null,
            }));

            return { model, items: ownedBy(attendees, pulled) };
          },
          orReportedNone("pull out the recording's action items", (reason) =>
            NoAiActionItems.make({ reason }),
          ),
        ),
      }),
    );

  static readonly layerNone = Layer.succeed(
    RecordingWriter,
    RecordingWriter.of({
      summarize: () => Effect.succeedNone,
      pullActionItems: () => Effect.succeedNone,
    }),
  );

  static readonly layer = writerLayer({
    withProviders: ({ banter }) => RecordingWriter.layerProviders(banter),
    withoutProviders: RecordingWriter.layerNone,
    withoutProvidersNote: "No AI provider configured, so recordings get no summary or action items",
  });
}
