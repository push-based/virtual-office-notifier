import { Array, type DateTime } from "effect";
import { formatOfficeTime } from "../history/describe-recording.ts";
import type { ErasureCase, ErasureInventory, RefusalGround } from "office-domain/Consent";
import { FORMER_MEMBER, REFUSAL_GROUNDS } from "office-domain/wire";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export const describeInventory = (inventory: ErasureInventory): ReadonlyArray<string> => [
  `${plural(inventory.voiceActivity, "voice activity row")}: joins, leaves, mutes, cameras and screen shares`,
  plural(inventory.soundsAndEmoji, "soundboard sound and emoji", "soundboard sounds and emoji"),
  `${plural(inventory.slackMessages, "Slack message")} and ${plural(inventory.slackReactions, "reaction")} of theirs the bot kept, with what it decided about them`,
  `${plural(inventory.clips, "spoken line")} in ${plural(inventory.recordingsSpokenIn, "recording")}, with ${plural(inventory.audioFiles, "audio file")}; each of those recordings gets a new transcript, summary and action items without them`,
  `${plural(inventory.recordingsStartedStoppedOrPaused, "recording")} they started, stopped or paused, ${plural(inventory.recordingRequests, "recording request")} and ${plural(inventory.recordingEdits, "edit")}, re-pointed at "${FORMER_MEMBER}"`,
  `${plural(inventory.actionItemsOwned, "action item")} they own, left without an owner`,
  inventory.names.length === 0
    ? "No name on record, so nothing to take out of other people's text"
    : `Their name (${Array.join(inventory.names, ", ")}) taken out of ${plural(inventory.linesMentioningThem, "other person's line", "other people's lines")}, ${plural(inventory.recordingTextsMentioningThem, "title, agenda, summary or action item", "titles, agendas, summaries and action items")}, ${inventory.slackPostsMentioningThem} of the bot's Slack posts and ${plural(inventory.slackMessagesMentioningThem, "other Slack message")}, in the database and in Slack`,
  "Their membership and consent history, keeping one row with no personal data as proof",
];

export const groundLabel = (ground: RefusalGround): string => REFUSAL_GROUNDS[ground];

export const adminName = (name: string | null): string => name ?? "an admin";

export const describeStanding = (erasure: ErasureCase): string => {
  switch (erasure.decision) {
    case "now":
      return `${adminName(erasure.decidedByName)} asked for it to run now; the bot is on it.`;
    case "refused":
      return `${adminName(erasure.decidedByName)} refused it because of ${groundLabel(erasure.refusal?.ground ?? "legal_obligation")}; the bot is telling them.`;
    case "cancelled":
      return "They cancelled it, or agreed to being recorded again; the bot is closing it.";
    case null:
      return erasure.seenBy.length === 0
        ? "Nobody has looked at it yet."
        : `Seen by ${Array.join(Array.map(erasure.seenByNames, adminName), " and ")}.`;
  }
};

export const officeTime = (at: DateTime.Utc): string => `${formatOfficeTime(at)}, UTC+2`;
