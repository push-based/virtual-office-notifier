import { badge, description, people, type Person } from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { ListedRecording, OfficeMember } from "../wire.ts";
import { canOpen, formatOfficeTime, formatRunTime, stateBadge } from "./describe-recording.ts";

export const personOf = (member: OfficeMember): Person => ({
  id: member.userId,
  name: member.name,
  avatarUrl: member.avatarUrl,
});

export interface RecordingRowConfig<Message> {
  readonly recording: ListedRecording;
  readonly now: number;
  readonly onOpen: Message;
}

export const factLine = (recording: ListedRecording, now: number): string =>
  [
    ...(recording.title === null ? [] : [formatOfficeTime(recording.startedAt)]),
    formatRunTime(recording.startedAt, recording.stoppedAt, now),
    `Started by ${recording.startedBy.name}`,
  ].join(" · ");

export const recordingRow = <Message>(
  h: HtmlBuilder<Message>,
  config: RecordingRowConfig<Message>,
): Html => {
  const { recording } = config;
  const state = stateBadge(recording.state);
  const speakers = recording.speakers.map(personOf);

  const facts = [
    h.span(
      [h.Class("recording-row-top")],
      [
        h.span(
          [h.Class("text-body recording-row-when")],
          [recording.title ?? formatOfficeTime(recording.startedAt)],
        ),
        badge(h, state.tone, state.label),
      ],
    ),
    description(h, [factLine(recording, config.now)]),
    speakers.length === 0
      ? h.empty
      : people(h, { id: `speakers-${recording.id}`, people: speakers }),
  ];

  return canOpen(recording.state)
    ? h.button([h.Type("button"), h.Class("recording-row"), h.OnClick(config.onOpen)], facts)
    : h.div([h.Class("recording-row")], facts);
};
