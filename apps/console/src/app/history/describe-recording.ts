import { DateTime, pipe, String } from "effect";
import type { BadgeTone } from "design-system";
import { OFFICE_TIME_ZONE } from "office-domain/OfficeStats";

import type {
  OfficeMember,
  RecordingDetail,
  RecordingState,
  TranscribedClip,
} from "office-domain/Recording";
import { SUMMARY_STYLE_LABELS } from "office-domain/wire";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value: number): string => pipe(`${value}`, String.padStart(2, "0"));

const inOffice = (at: DateTime.Utc) => DateTime.toParts(DateTime.setZone(at, OFFICE_TIME_ZONE));

export const formatClock = (at: DateTime.Utc): string => {
  const { hour, minute } = inOffice(at);

  return `${pad(hour)}:${pad(minute)}`;
};

export const formatOfficeTime = (at: DateTime.Utc): string => {
  const { weekDay, day, month } = inOffice(at);

  return `${DAYS[weekDay]} ${day} ${MONTHS[month - 1]}, ${formatClock(at)}`;
};

export const formatRunTime = (
  startedAt: DateTime.Utc,
  stoppedAt: DateTime.Utc | null,
  now: number,
): string => {
  const end = stoppedAt === null ? now : DateTime.toEpochMillis(stoppedAt);
  const minutes = Math.floor(Math.max(0, end - DateTime.toEpochMillis(startedAt)) / 60_000);

  if (minutes < 1) return "under a minute";

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};

export interface StateBadge {
  readonly label: string;
  readonly tone: BadgeTone;
}

export const stateBadge = (state: RecordingState): StateBadge => {
  switch (state) {
    case "running":
      return { label: "Running", tone: "live" };
    case "transcribing":
      return { label: "Transcribing", tone: "pending" };
    case "finished":
      return { label: "Finished", tone: "done" };
    case "silent":
      return { label: "Silent", tone: "quiet" };
  }
};

export const canOpen = (state: RecordingState): boolean => state !== "silent";

export const isLive = (state: RecordingState): boolean =>
  state === "running" || state === "transcribing";

export const isChanging = (recording: RecordingDetail): boolean =>
  isLive(recording.state) || recording.rewriting;

export const summaryCredit = (recording: RecordingDetail): string | null =>
  recording.summaryModel === null
    ? null
    : `✨ ${SUMMARY_STYLE_LABELS[recording.summaryWrittenStyle ?? recording.summaryStyle]} summary by ${recording.summaryModel}`;

export const describeStop = (recording: RecordingDetail): string | null => {
  switch (recording.stopReason) {
    case null:
      return null;
    case "requested":
      return recording.stoppedBy === null ? "Stopped" : `Stopped by ${recording.stoppedBy.name}`;
    case "office_emptied":
      return "Office emptied";
    case "time_limit":
      return "Hit the 4-hour limit";
    case "bot_restarted":
      return "Bot restarted";
  }
};

export const NO_SUMMARY =
  "No AI model could write a summary this time. The full transcript is in the thread.";

export interface TranscriptTurn {
  readonly speaker: OfficeMember;
  readonly startedAt: DateTime.Utc;
  readonly lines: ReadonlyArray<string>;
}

export const transcriptTurns = (
  clips: ReadonlyArray<TranscribedClip>,
): ReadonlyArray<TranscriptTurn> => {
  const turns: Array<TranscriptTurn> = [];

  for (const clip of clips) {
    const last = turns.at(-1);

    if (last !== undefined && last.speaker.userId === clip.speaker.userId) {
      turns[turns.length - 1] = { ...last, lines: [...last.lines, clip.text] };
    } else {
      turns.push({ speaker: clip.speaker, startedAt: clip.startedAt, lines: [clip.text] });
    }
  }

  return turns;
};
