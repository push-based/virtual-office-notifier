import { formatElapsed, formatTimeLeft, formatTimeSince } from "design-system";

import type { OfficePhase } from "./models";

export interface PhaseDescription {
  readonly heading: string;
  readonly description: string;
  readonly live: boolean;
}

export const describePhase = (phase: OfficePhase, now: number): PhaseDescription => {
  switch (phase.kind) {
    case "failed":
      return { heading: "Couldn't start", description: phase.reason, live: false };
    case "connecting":
      return { heading: "Connecting…", description: "Hold on a moment.", live: false };
    case "away":
      return {
        heading: "The bot isn't in the office yet",
        description: "It joins once someone is in the voice channel.",
        live: false,
      };
    case "idle":
      return {
        heading: "Not recording",
        description: "Press start to record and transcribe the office.",
        live: false,
      };
    case "recording":
      return {
        heading: `Recording · ${formatElapsed(phase.recording.startedAt, now)}`,
        description: `Started by ${phase.recording.startedByName} · ${formatTimeLeft(phase.recording.endsAt, now)} left`,
        live: true,
      };
    case "paused":
      return {
        heading: `Paused by ${phase.pause.byName} · ${formatTimeSince(phase.pause.since, now)}`,
        description: `Started by ${phase.recording.startedByName} · ${formatTimeLeft(phase.recording.endsAt, now)} left`,
        live: false,
      };
  }
};
