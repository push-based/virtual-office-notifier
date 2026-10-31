import { DateTime, pipe, String } from "effect";

export const OFFICE_TIME_ZONE = DateTime.zoneMakeOffset(2 * 60 * 60 * 1000);

export const OFFICE_HOURS = { from: 9, until: 18 };

const MONDAY = 1;

const FRIDAY = 5;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const inOfficeTime = (at: DateTime.Utc): DateTime.Zoned =>
  DateTime.setZone(at, OFFICE_TIME_ZONE);

export const isOfficeHours = (at: DateTime.Utc): boolean => {
  const { weekDay, hour } = DateTime.toParts(inOfficeTime(at));

  return (
    weekDay >= MONDAY && weekDay <= FRIDAY && hour >= OFFICE_HOURS.from && hour < OFFICE_HOURS.until
  );
};

export const startOfOfficeDay = (at: DateTime.Utc): DateTime.Utc =>
  DateTime.toUtc(DateTime.startOf(inOfficeTime(at), "day"));

export const startOfOfficeWeek = (at: DateTime.Utc): DateTime.Utc =>
  DateTime.toUtc(DateTime.startOf(inOfficeTime(at), "week", { weekStartsOn: MONDAY }));

const twoDigits = (value: number): string => pipe(`${value}`, String.padStart(2, "0"));

export const officeClock = (at: DateTime.Utc): string => {
  const { weekDay, day, month, hour, minute } = DateTime.toParts(inOfficeTime(at));

  return `${WEEKDAY_NAMES[weekDay]} ${day} ${MONTH_NAMES[month - 1]} ${twoDigits(hour)}:${twoDigits(minute)}`;
};
