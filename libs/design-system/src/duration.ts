import { DateTime } from "effect";

const pad = (value: number): string => String(value).padStart(2, "0");

export const formatElapsed = (since: DateTime.Utc, now: number): string => {
  const total = Math.max(0, Math.floor((now - DateTime.toEpochMillis(since)) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const formatMinutes = (minutes: number): string =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

export const formatDuration = (seconds: number): string =>
  formatMinutes(Math.max(0, Math.round(seconds / 60)));

export const formatTimeLeft = (until: DateTime.Utc, now: number): string =>
  formatMinutes(Math.max(0, Math.ceil((DateTime.toEpochMillis(until) - now) / 60_000)));

export const formatTimeSince = (since: DateTime.Utc, now: number): string =>
  formatMinutes(Math.max(0, Math.floor((now - DateTime.toEpochMillis(since)) / 60_000)));
