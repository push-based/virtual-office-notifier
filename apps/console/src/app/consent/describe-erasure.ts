import {
  type ErasureInventory,
  FORMER_MEMBER,
  type RefusalGround,
  REFUSAL_GROUNDS,
} from "recording-requests/wire";

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
    : `Their name (${inventory.names.join(", ")}) taken out of ${plural(inventory.linesMentioningThem, "other person's line", "other people's lines")}, ${plural(inventory.recordingTextsMentioningThem, "title, agenda, summary or action item", "titles, agendas, summaries and action items")}, ${inventory.slackPostsMentioningThem} of the bot's Slack posts and ${plural(inventory.slackMessagesMentioningThem, "other Slack message")}, in the database and in Slack`,
  "Their membership and consent history, keeping one row with no personal data as proof",
];

export const groundLabel = (ground: RefusalGround): string => REFUSAL_GROUNDS[ground];

export const adminName = (name: string | null): string => name ?? "an admin";
