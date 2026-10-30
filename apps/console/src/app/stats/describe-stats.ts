import { type Bar, formatDuration, type HeatmapRow, type Tab } from "design-system";
import type { BusyHour, OfficeStats, PersonDays, StatsRange } from "recording-requests/wire";

export interface RangeTab extends Tab {
  readonly id: StatsRange;
}

export const RANGES: ReadonlyArray<RangeTab> = [
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface BusiestGrid {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<HeatmapRow>;
}

export interface StatsView {
  readonly recordings: string;
  readonly recorded: string;
  readonly timeInOffice: ReadonlyArray<Bar>;
  readonly firstIn: ReadonlyArray<Bar>;
  readonly lastOut: ReadonlyArray<Bar>;
  readonly busiest: BusiestGrid;
  readonly sounds: ReadonlyArray<Bar>;
  readonly players: ReadonlyArray<Bar>;
  readonly reactions: ReadonlyArray<Bar>;
}

export const rangeOf = (id: string): StatsRange =>
  RANGES.find((range) => range.id === id)?.id ?? "week";

export const emojiLabel = (emoji: string): string =>
  /^[\w-]+$/.test(emoji) ? `:${emoji}:` : emoji;

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const peopleIn = (people: number | null): string => {
  if (people === null) return "not yet";

  if (people === 0) return "nobody in";

  return `${people} ${people === 1 ? "person" : "people"} in on average`;
};

export const busiestGrid = (hours: ReadonlyArray<BusyHour>): BusiestGrid => {
  const busy = hours.flatMap((hour) => (hour.people > 0 ? [hour.hour] : []));

  if (busy.length === 0) return { columns: [], rows: [] };

  const first = Math.min(...busy);
  const shown = Array.from({ length: Math.max(...busy) - first + 1 }, (_, index) => first + index);

  return {
    columns: shown.map(String),
    rows: WEEKDAYS.map((weekday, index) => ({
      label: weekday,
      cells: shown.map((hour) => {
        const people =
          hours.find((busy) => busy.weekday === index + 1 && busy.hour === hour)?.people ?? null;

        return { value: people, description: `${weekday} ${hour}:00, ${peopleIn(people)}` };
      }),
    })),
  };
};

const dayBars = (people: ReadonlyArray<PersonDays>): ReadonlyArray<Bar> =>
  people.map((person) => ({
    id: person.userId,
    label: person.name,
    value: person.days,
    display: plural(person.days, "day", "days"),
  }));

export const describeStats = (stats: OfficeStats): StatsView => ({
  recordings: String(stats.recordings.count),
  recorded: formatDuration(stats.recordings.seconds),
  timeInOffice: stats.timeInOffice.map((person) => ({
    id: person.userId,
    label: person.name,
    value: person.seconds,
    display: formatDuration(person.seconds),
  })),
  firstIn: dayBars(stats.firstIn),
  lastOut: dayBars(stats.lastOut),
  busiest: busiestGrid(stats.busiestHours),
  sounds: stats.sounds.map((sound) => ({
    id: sound.sound,
    label: sound.sound,
    value: sound.plays,
    display: String(sound.plays),
  })),
  players: stats.players.map((player) => ({
    id: player.userId,
    label: player.name,
    value: player.plays,
    display: String(player.plays),
  })),
  reactions: stats.reactions.map((reaction) => ({
    id: reaction.emoji,
    label: emojiLabel(reaction.emoji),
    value: reaction.reactions,
    display: String(reaction.reactions),
  })),
});
