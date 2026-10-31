import { Cron, DateTime, Effect, Schedule, Stream } from "effect";

import { OfficeEvent, type OfficeLocation } from "../OfficeEvent.ts";
import { OFFICE_TIME_ZONE } from "../OfficeTime.ts";

const reminderCron = Cron.make({
  minutes: [15],
  hours: [11],
  days: [],
  months: [],
  weekdays: [1, 2, 3, 4, 5],
  tz: OFFICE_TIME_ZONE,
});

export const reminders = (office: OfficeLocation): Stream.Stream<OfficeEvent> =>
  Stream.fromSchedule(Schedule.cron(reminderCron)).pipe(
    // Only a cron string can fail to parse, and this one is already built.
    Stream.orDie,
    Stream.mapEffect(() =>
      Effect.map(DateTime.now, (at) => OfficeEvent.Reminder({ ...office, at })),
    ),
  );
