import { Array, DateTime, Option, pipe, String } from "effect";
import { type SummaryStyle, summaryStyleLabel } from "recording-requests/Recording";

import {
  AI_DISCLAIMER,
  context,
  escapeSlackText,
  formatDuration,
  headline,
  mrkdwn,
  type SectionBlock,
  type SlackMessage,
} from "../slack/index.ts";
import type { OfficeLocation } from "../OfficeEvent.ts";
import { type ActionItemLine, ActionItemList } from "./ActionItems.ts";

export interface RecordingSummary {
  readonly office: OfficeLocation;
  readonly startedAt: DateTime.Utc;
  readonly stoppedAt: DateTime.Utc;
  readonly startedByName: string;
  readonly title: string | null;
  readonly speakers: ReadonlyArray<string>;
  readonly summary: Option.Option<{
    readonly text: string;
    readonly model: string;
    readonly style: SummaryStyle;
  }>;
  readonly actionItems: ActionItemList;
}

const NO_SUMMARY =
  "No AI model could write a summary this time. The full transcript is in the thread.";

export const NO_ACTION_ITEMS = "No action items could be pulled out";

export const NONE_TAKEN_ON = "Nobody took anything on";

const actionItemLine = ({ text, ownerName, done }: ActionItemLine): string => {
  const line = `• ${escapeSlackText(ownerName ?? "Unassigned")}: ${escapeSlackText(text)}`;

  return done ? `~${line}~ ✅` : line;
};

const actionItemsBlock = (list: ActionItemList): ReadonlyArray<SectionBlock> =>
  ActionItemList.$match(list, {
    NotTried: () => [],
    Failed: () => [headline(`*Action items*\n${NO_ACTION_ITEMS}`, Option.none())],
    Pulled: ({ items }) => [
      headline(
        Array.join(
          [
            "*Action items*",
            ...(items.length === 0 ? [NONE_TAKEN_ON] : Array.map(items, actionItemLine)),
          ],
          "\n",
        ),
        Option.none(),
      ),
    ],
  });

const slackDate = (at: DateTime.Utc): string =>
  `<!date^${DateTime.toEpochSeconds(at)}^{date_short} {time}|${pipe(DateTime.formatIso(at), String.slice(0, 16), String.replace("T", " "))} UTC>`;

export const summaryMessage = (recording: RecordingSummary): SlackMessage => {
  const duration = formatDuration(DateTime.distance(recording.startedAt, recording.stoppedAt));
  const when = slackDate(recording.startedAt);

  const { heading, notification } =
    recording.title === null
      ? {
          heading: `📝 *Office recording* from ${when}, ${duration}`,
          notification: `📝 Office recording, ${duration}`,
        }
      : {
          heading: `📝 *${escapeSlackText(recording.title)}* · ${when}, ${duration}`,
          notification: `📝 ${escapeSlackText(recording.title)}, ${duration}`,
        };

  const body = Option.match(recording.summary, {
    onNone: () => NO_SUMMARY,
    onSome: ({ text }) => escapeSlackText(text),
  });

  return {
    text: notification,
    blocks: [
      headline(heading, Option.none()),
      headline(body, Option.none()),
      ...actionItemsBlock(recording.actionItems),
      {
        type: "section",
        fields: [
          mrkdwn(`*Started by*\n${escapeSlackText(recording.startedByName)}`),
          mrkdwn(
            `*Who spoke*\n${recording.speakers.length === 0 ? "Nobody" : pipe(recording.speakers, Array.map(escapeSlackText), Array.join(", "))}`,
          ),
        ],
      },
      context(
        ...Option.match(recording.summary, {
          onNone: () => ["📄 Full transcript in the thread"],
          onSome: ({ model, style }) => [
            `✨ ${escapeSlackText(summaryStyleLabel(style))} summary by ${escapeSlackText(model)}`,
            AI_DISCLAIMER,
            "📄 Full transcript in the thread",
          ],
        }),
      ),
    ],
  };
};

export const rewriteNote = (
  newStyle: Option.Option<SummaryStyle>,
  byName: string,
): SlackMessage => {
  const by = escapeSlackText(byName);

  const text = Option.match(newStyle, {
    onNone: () => `✨ Summary rewritten by ${by}`,
    onSome: (style) =>
      `✨ Summary rewritten as ${escapeSlackText(summaryStyleLabel(style))} by ${by}`,
  });

  return { text, blocks: [context(text)] };
};
