import {
  avatar,
  badge,
  button,
  description,
  divider,
  eyebrow,
  heading,
  people,
} from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { RecordingDetail } from "../wire.ts";
import {
  describeStop,
  formatClock,
  formatOfficeTime,
  formatRunTime,
  isLive,
  NO_SUMMARY,
  stateBadge,
  summaryCredit,
  type TranscriptTurn,
  transcriptTurns,
} from "./describe-recording.ts";
import { personOf } from "./recording-row.ts";

export interface RecordingPageConfig<Message> {
  readonly recording: RecordingDetail;
  readonly now: number;
  readonly back: Html;
  readonly editor: Html;
  readonly rewrite: Html;
  readonly actionItems: Html;
  readonly onOpenInSlack: (url: string) => Message;
}

export const pageFacts = (recording: RecordingDetail, now: number): string =>
  [
    ...(recording.title === null ? [] : [formatOfficeTime(recording.startedAt)]),
    formatRunTime(recording.startedAt, recording.stoppedAt, now),
    `Started by ${recording.startedBy.name}`,
    ...[describeStop(recording)].flatMap((stop) => (stop === null ? [] : [stop])),
  ].join(" · ");

const headerView = <Message>(
  h: HtmlBuilder<Message>,
  config: RecordingPageConfig<Message>,
): Html => {
  const { recording } = config;
  const state = stateBadge(recording.state);
  const speakers = recording.speakers.map(personOf);

  return h.header(
    [h.Class("stack-2")],
    [
      h.div(
        [h.Class("recording-page-top")],
        [
          heading(h, recording.title ?? formatOfficeTime(recording.startedAt)),
          badge(h, state.tone, state.label),
        ],
      ),
      description(h, [pageFacts(recording, config.now)]),
      speakers.length === 0
        ? h.empty
        : people(h, { id: "who-spoke", people: speakers, label: "Who spoke" }),
      recording.agenda === null
        ? h.empty
        : h.section(
            [h.Class("stack-2"), h.AriaLabelledBy("agenda-heading")],
            [
              eyebrow(h, { text: "Agenda", tone: "muted", id: "agenda-heading" }),
              h.p([h.Class("text-body preserved-lines")], [recording.agenda]),
            ],
          ),
      config.editor,
    ],
  );
};

const summaryView = <Message>(
  h: HtmlBuilder<Message>,
  config: RecordingPageConfig<Message>,
): ReadonlyArray<Html> => {
  const { recording } = config;
  const credit = summaryCredit(recording);

  if (recording.state !== "finished") return [];

  return [
    divider(h),
    h.section(
      [h.Class("stack-2"), h.AriaLabelledBy("summary-heading")],
      [
        eyebrow(h, { text: "Summary", tone: "muted", id: "summary-heading" }),
        h.p([h.Class("text-body preserved-lines")], [recording.summary ?? NO_SUMMARY]),
        recording.rewriting
          ? h.p([h.Class("text-caption recording-page-footer"), h.Role("status")], ["Rewriting…"])
          : credit === null
            ? h.empty
            : h.p([h.Class("text-caption recording-page-footer")], [credit]),
        config.rewrite,
      ],
    ),
    config.actionItems,
  ];
};

const turnView = <Message>(h: HtmlBuilder<Message>, turn: TranscriptTurn): Html =>
  h.keyed("li")(
    `${turn.startedAt}${turn.speaker.userId}`,
    [h.Class("transcript-turn")],
    [
      avatar(h, { name: turn.speaker.name, src: turn.speaker.avatarUrl }),
      h.div(
        [h.Class("transcript-said")],
        [
          h.p(
            [h.Class("text-body-sm transcript-who")],
            [
              h.span([h.Class("transcript-name")], [turn.speaker.name]),
              h.span([h.Class("text-caption transcript-time")], [formatClock(turn.startedAt)]),
            ],
          ),
          ...turn.lines.map((line) => h.p([h.Class("text-body preserved-lines")], [line])),
        ],
      ),
    ],
  );

const transcriptView = <Message>(h: HtmlBuilder<Message>, recording: RecordingDetail): Html => {
  const turns = transcriptTurns(recording.clips);

  return h.section(
    [h.Class("stack-2"), h.AriaLabelledBy("transcript-heading")],
    [
      eyebrow(h, { text: "Transcript", tone: "muted", id: "transcript-heading" }),
      h.ol(
        [h.Class("transcript")],
        turns.length === 0
          ? [h.li([h.Class("text-body-sm pb-description")], ["Nothing transcribed yet."])]
          : turns.map((turn) => turnView(h, turn)),
      ),
      isLive(recording.state) ? description(h, ["More on the way…"]) : h.empty,
    ],
  );
};

export const recordingPage = <Message>(
  h: HtmlBuilder<Message>,
  config: RecordingPageConfig<Message>,
): Html => {
  const { recording } = config;

  return h.article(
    [h.Class("recording-page")],
    [
      config.back,
      headerView(h, config),
      ...summaryView(h, config),
      recording.slackPermalink === null
        ? h.empty
        : button(h, {
            label: ["Open in Slack"],
            variant: "ghost",
            onClick: config.onOpenInSlack(recording.slackPermalink),
          }),
      divider(h),
      transcriptView(h, recording),
    ],
  );
};
