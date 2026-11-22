import type { Occupants } from "./OfficeEvent.ts";

export type BotPresence = "InOffice" | "Away";

export const presenceOf = (occupants: Occupants): BotPresence =>
  occupants.size > 0 ? "InOffice" : "Away";
