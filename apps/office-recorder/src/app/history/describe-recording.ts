import type { BadgeTone } from "design-system";

import type { OfficeMember, RecordingDetail, RecordingState, TranscribedClip } from "./models";

const OFFICE_OFFSET_MS = 2 * 60 * 60 * 1000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value: number): string => String(value).padStart(2, "0");

const inOffice = (iso: string): Date => new Date(Date.parse(iso) + OFFICE_OFFSET_MS);

export const formatClock = (iso: string): string => {
  const at = inOffice(iso);

  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
};

export const formatOfficeTime = (iso: string): string => {
  const at = inOffice(iso);

  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}, ${formatClock(iso)}`;
};

export const formatRunTime = (startedAt: string, stoppedAt: string | null, now: number): string => {
  const end = stoppedAt === null ? now : Date.parse(stoppedAt);
  const minutes = Math.floor(Math.max(0, end - Date.parse(startedAt)) / 60_000);

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
  readonly startedAt: string;
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
