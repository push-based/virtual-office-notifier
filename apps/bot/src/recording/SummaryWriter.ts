import {
  Array,
  DateTime,
  ErrorReporter,
  type LogLevel,
  Order,
  pipe,
  Schema,
  type SchemaAST,
  String,
} from "effect";
import type { SummaryStyle } from "recording-requests/Recording";

import { type Brief, unquoted } from "../AiWriting.ts";
import { officeClock } from "../OfficeTime.ts";
import type { ClipLine, PauseLine, RecordingDetails } from "./RecordingStore.ts";
import { escapeSlackText, formatDuration } from "../SlackMessage.ts";

export const MAX_SUMMARY_LENGTH = 1500;

export const SLACK_SECTION_LIMIT = 3000;

export const DETAILED_OUTPUT_TOKENS = 1000;

const summaryText = (limit: SchemaAST.Check<string>) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isMinLength(1), limit, Schema.isPattern(/^[^<>]+$/s)),
      unquoted,
    ),
  );

export const SummaryText = summaryText(Schema.isMaxLength(MAX_SUMMARY_LENGTH));

export const DetailedSummaryText = summaryText(
  Schema.makeFilter<string>((text) => escapeSlackText(text).length <= SLACK_SECTION_LIMIT, {
    expected: `a summary that fits one Slack section of ${SLACK_SECTION_LIMIT} characters`,
  }),
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
  readonly style: SummaryStyle;
}

const summaryPrompt = (task: string, format: string): string =>
  Array.join(
    [
      "You summarize a recorded conversation from a team's virtual office, a Discord voice channel where people work alongside each other. The transcript was made by speech recognition, one line per stretch of speech, each with the time in UTC+2 and who spoke.",
      task,
      "The request can start with the recording's title and agenda. The agenda is what people meant to cover when they planned it, not what happened: use it to make sense of the conversation, but never say something was discussed or decided unless the transcript shows it.",
      "A line like '14:20–14:35 Paused by Ben' marks a pause: nothing was recorded in that stretch, so don't join what was said before and after it into one topic, and don't guess what was said during it.",
      "Only say what the transcript shows. Speech recognition gets words wrong, so when a line makes no sense, skip it rather than guess.",
      "Name people exactly as they're written in the transcript. Refer to people by name or as they, never as he or she.",
      format,
    ],
    "\n",
  );

export const STYLE_BRIEFS: Record<SummaryStyle, Omit<Brief<string>, "request">> = {
  brief: {
    prompt: summaryPrompt(
      "Write a summary for the team's Slack channel: what was discussed and any decisions. Leave out the action items, which are listed separately, and small talk unless it's the whole conversation.",
      "Reply with plain text only: short lines starting with •, no headings, no markdown, no quotes, no labels, nothing in angle brackets. Keep the whole reply under 1,200 characters.",
    ),
    reply: SummaryText,
  },
  detailed: {
    prompt: summaryPrompt(
      "Write a detailed summary for the team's Slack channel, grouped by topic: for each topic that was discussed, its main points and anything decided about it. Leave out the action items, which are listed separately, and small talk unless it's the whole conversation.",
      "Reply with plain text only: for each topic, one short line naming it, then its points and decisions on lines starting with •, with an empty line between topics. No markdown, no quotes, no labels, nothing in angle brackets. Keep the whole reply under 2,800 characters.",
    ),
    reply: DetailedSummaryText,
    maxOutputTokens: DETAILED_OUTPUT_TOKENS,
  },
  decisions: {
    prompt: summaryPrompt(
      "Write only what was decided, for the team's Slack channel: each decision, with who it concerns when the transcript says. Leave out the discussion that led there, anything that wasn't decided, and the action items, which are listed separately. If nothing was decided, say so in one line.",
      "Reply with plain text only: short lines starting with •, one per decision, no headings, no markdown, no quotes, no labels, nothing in angle brackets. Keep the whole reply under 1,200 characters.",
    ),
    reply: SummaryText,
  },
};

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

export const summaryRequest = (details: RecordingDetails, transcript: string): string =>
  Array.join(
    [
      ...(details.title === null ? [] : [`Title: ${details.title}`]),
      ...(details.agenda === null
        ? []
        : ["Agenda, what people meant to cover, not what happened:", details.agenda]),
      ...(details.title === null && details.agenda === null ? [] : ["", "Transcript:"]),
      transcript,
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
