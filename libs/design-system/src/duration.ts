const pad = (value: number): string => String(value).padStart(2, "0");

export const formatElapsed = (since: string, now: number): string => {
  const total = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
};

const formatMinutes = (minutes: number): string =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

export const formatDuration = (seconds: number): string =>
  formatMinutes(Math.max(0, Math.round(seconds / 60)));

export const formatTimeLeft = (until: string, now: number): string =>
  formatMinutes(Math.max(0, Math.ceil((Date.parse(until) - now) / 60_000)));

export const formatTimeSince = (since: string, now: number): string =>
  formatMinutes(Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)));
