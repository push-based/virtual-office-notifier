import { Array, Option, pipe } from "effect";
import { type Bar, formatDuration, type HeatmapRow, type Tab } from "design-system";
import type { BusyHour, OfficeStats, PersonDays, StatsRange } from "office-domain/OfficeStats";

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
  pipe(
    RANGES,
    Array.findFirst((range) => range.id === id),
    Option.match({ onNone: () => "week", onSome: (range) => range.id }),
  );

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
  const busy = Array.flatMap(hours, (hour) => (hour.people > 0 ? [hour.hour] : []));

  if (busy.length === 0) return { columns: [], rows: [] };

  const first = Math.min(...busy);
  const shown = Array.range(first, Math.max(...busy));

  return {
    columns: Array.map(shown, String),
    rows: Array.map(WEEKDAYS, (weekday, index) => ({
      label: weekday,
      cells: Array.map(shown, (hour) => {
        const people = pipe(
          hours,
          Array.findFirst((busy) => busy.weekday === index + 1 && busy.hour === hour),
          Option.map((busy) => busy.people),
          Option.getOrNull,
        );

        return { value: people, description: `${weekday} ${hour}:00, ${peopleIn(people)}` };
      }),
    })),
  };
};

const dayBars = (people: ReadonlyArray<PersonDays>): ReadonlyArray<Bar> =>
  Array.map(people, (person) => ({
    id: person.userId,
    label: person.name,
    value: person.days,
    display: plural(person.days, "day", "days"),
  }));

export const describeStats = (stats: OfficeStats): StatsView => ({
  recordings: String(stats.recordings.count),
  recorded: formatDuration(stats.recordings.seconds),
  timeInOffice: Array.map(stats.timeInOffice, (person) => ({
    id: person.userId,
    label: person.name,
    value: person.seconds,
    display: formatDuration(person.seconds),
  })),
  firstIn: dayBars(stats.firstIn),
  lastOut: dayBars(stats.lastOut),
  busiest: busiestGrid(stats.busiestHours),
  sounds: Array.map(stats.sounds, (sound) => ({
    id: sound.sound,
    label: sound.sound,
    value: sound.plays,
    display: String(sound.plays),
  })),
  players: Array.map(stats.players, (player) => ({
    id: player.userId,
    label: player.name,
    value: player.plays,
    display: String(player.plays),
  })),
  reactions: Array.map(stats.reactions, (reaction) => ({
    id: reaction.emoji,
    label: emojiLabel(reaction.emoji),
    value: reaction.reactions,
    display: String(reaction.reactions),
  })),
});
