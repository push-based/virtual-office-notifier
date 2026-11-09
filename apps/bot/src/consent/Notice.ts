import { Array, DateTime, Duration, Option } from "effect";
import type {
  ErasureCase,
  ErasureInventory,
  RefusalGround,
  Wording,
} from "recording-requests/Consent";
import {
  CONSENT_ANSWER_MS,
  DATA_PROTECTION_AUTHORITIES_URL,
  FORMER_MEMBER,
  RECORDED_IN_THE_OFFICE,
  REFUSAL_GROUNDS,
} from "recording-requests/wire";

export const ANSWER_TIME = Duration.millis(CONSENT_ANSWER_MS);

export const AGREE_LABEL = "I agree";

export const DECLINE_LABEL = "No thanks";

const recorded = Array.join(
  Array.map(RECORDED_IN_THE_OFFICE, (item) => `- ${item}`),
  "\n",
);

const changeYourMind =
  "You can change your mind any time: withdraw your consent from the Console, the rocket button in the voice channel, or ask us to delete everything we hold about you.";

const firstAsk = (name: string) =>
  Array.join(
    [
      `**Welcome to the virtual office, ${name} 👋**`,
      `Before you settle in, we need your OK. While you're here, the office records:\n${recorded}`,
      "It's shared in the office Slack channel, and AI models read it to write the office banter and summarise recordings. That's how the office works, so it can't be switched off for one person.",
      "Under the GDPR we need your clear yes before we record any of it, and until you answer we record nothing about you.",
      "If we don't hear from you within a minute, the bot will have to show you out, and honestly, we'll be heartbroken. The office is quieter without you. Your seat will sit there, empty and a little sad, until you come back.",
      changeYourMind,
    ],
    "\n\n",
  );

const askAgain = (name: string) =>
  Array.join(
    [
      `**You came back, ${name} 🥹**`,
      `We've missed you more than we'd like to admit. Nothing has changed, we're afraid. While you're here, the office still records:\n${recorded}`,
      "It still goes to the office Slack channel and to the AI models that write the banter and summarise recordings, and we still need your clear yes under the GDPR before we can let you stay. Until you answer, we record nothing about you.",
      "You have a minute again. If we don't hear from you, the bot will have to show you out once more, and it'll hurt just as much as last time.",
      changeYourMind,
    ],
    "\n\n",
  );

export const askFor = (wording: Wording, name: string): string =>
  wording === "first" ? firstAsk(name) : askAgain(name);

export const AGREED = (name: string) =>
  `**Thank you, ${name} 💛**\n\nMake yourself at home. You can withdraw your consent any time from the Console, the rocket button in the voice channel.`;

export const DECLINED =
  "We understand, and we're so, so sorry to see you go. The office won't be the same without you. The door's always open: if you ever change your mind, just come back in.";

export const TIMED_OUT =
  "We didn't hear back from you, so we've had to show you out. It breaks our hearts a little. Come back whenever you're ready, and we'll ask again.";

export const LEFT =
  "You left before answering, so there's nothing to decide for now. We'll ask again next time you come in.";

export const RESTARTING =
  "The bot is restarting, so this question has lapsed. If you're still in the office when it's back, it'll ask again.";

export const EXPIRED =
  "This question has expired. If you're in the office, a new one is on its way.";

export const NOT_YOURS = "This question is for someone else.";

export const QUESTION_WITHDRAWN =
  "You've withdrawn your consent from the Console, so this question no longer applies.";

export const WITHDRAWN_AND_SHOWN_OUT =
  "We've withdrawn your consent, as you asked, and shown you out of the office. We'll miss you terribly. Nothing new is recorded about you from now on. If you ever want to come back, just join, and we'll ask you again.";

export const WITHDRAWN =
  "We've withdrawn your consent, as you asked. Nothing new is recorded about you from now on, and the office will miss you terribly. If you ever want to come back, just join, and we'll ask you again.";

const ERASED_DETAIL =
  "Your activity, your sounds and emoji, your Slack messages the bot kept, and your lines and audio in every recording are gone, and we've taken your name out of what's left, like other people's lines and the bot's posts. Our backups age out within a week.";

export const ERASED_AND_SHOWN_OUT = `We've deleted everything we held about you, as you asked, and shown you out of the office. ${ERASED_DETAIL} We'll miss you more than we can say. If you ever want to come back, just join, and we'll ask you as if we'd never met.`;

export const ERASED = `We've deleted everything we held about you, as you asked. ${ERASED_DETAIL} We'll miss you more than we can say. If you ever want to come back, just join, and we'll ask you as if we'd never met.`;

export const QUESTION_ERASED =
  "You've asked us to delete your data from the Console, so this question no longer applies.";

export const SHOWN_OUT_REASON = "Didn't agree to being recorded in the office";

export const ERASED_REASON = "Asked for their data to be deleted";

export type Markup = "discord" | "slack";

const bold = (markup: Markup, text: string) => (markup === "slack" ? `*${text}*` : `**${text}**`);

const bullet = (markup: Markup) => (markup === "slack" ? "• " : "- ");

const list = (markup: Markup, items: ReadonlyArray<string>) =>
  Array.join(
    Array.map(items, (item) => `${bullet(markup)}${item}`),
    "\n",
  );

export const formatDay = (at: DateTime.Utc): string =>
  DateTime.format(at, { locale: "en-GB", dateStyle: "long", timeZone: "Europe/Vienna" });

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export const DELETE_NOW_LABEL = "Delete now";

export const LET_IT_RUN_LABEL = "Let it run";

export const REFUSE_LABELS: Readonly<Record<RefusalGround, string>> = {
  legal_obligation: "Refuse: legal obligation",
  legal_claim: "Refuse: legal claim",
};

export const REFUSAL_REASON_LABEL = "Why it has to be kept. This goes to them, word for word.";

export const REFUSAL_INPUT_LABEL = "Why it has to be kept (this goes to them)";

export const REFUSAL_MODAL_TITLE = "Refuse the deletion";

export const NOT_AN_ADMIN = "This is for the office admins.";

export const ALREADY_DECIDED = "This request was already decided, or the deletion has already run.";

export const NOTED_NOW = "Noted. The bot deletes it within a minute, then tells them.";

export const NOTED_SEEN = "Noted as seen. It still runs on the due date unless someone acts.";

export const NOTED_REFUSED = "Refused. They'll be told why, and that they can complain.";

export const SCHEDULED = (dueAt: DateTime.Utc, shownOut: boolean) =>
  Array.join(
    [
      `**We've got your request to delete everything we hold about you 💛**`,
      `Your consent is withdrawn as of now${shownOut ? ", and we've shown you out of the office" : ""}. Nothing new is recorded about you from here on.`,
      `The deletion itself runs on ${formatDay(dueAt)}, or sooner if the office admins decide so. Until then they check whether anything has to be kept by law, which is the only thing that could stop it, and you'd be told why.`,
      "You can cancel from the Console's Privacy tab until it runs. Coming back to the office and agreeing to being recorded cancels it too, and the question will say so.",
    ],
    "\n\n",
  );

export const CANCELLED =
  "Your request to delete your data is cancelled, either because you cancelled it or because you agreed to being recorded again. Nothing was deleted, and the office is glad to have you. You can ask again from the Console any time.";

export const REFUSED = (ground: RefusalGround, reason: string) =>
  Array.join(
    [
      "**We can't delete your data, and we're sorry 💔**",
      `The office admins have decided to keep it because of ${REFUSAL_GROUNDS[ground]}. Their reason, in their words:`,
      `> ${reason}`,
      "Your consent stays withdrawn, so nothing new is recorded about you. What we hold is kept only for that reason and nothing else.",
      `If you think that's wrong, you can complain to a data protection authority: ${DATA_PROTECTION_AUTHORITIES_URL}`,
    ],
    "\n\n",
  );

const PENDING_ERASURE =
  "You've asked us to delete your data, and that request is still open. If you agree now, it's cancelled: nothing is deleted, and the office records you again as before. Say **No thanks** to keep the request.";

export const askAbout = (wording: Wording, name: string, pendingErasure: boolean): string =>
  pendingErasure
    ? Array.join([askFor(wording, name), PENDING_ERASURE], "\n\n")
    : askFor(wording, name);

export const describeInventory = (inventory: ErasureInventory): ReadonlyArray<string> => [
  `${plural(inventory.voiceActivity, "voice activity row")}: joins, leaves, mutes, cameras and screen shares`,
  `${plural(inventory.soundsAndEmoji, "soundboard sound and emoji", "soundboard sounds and emoji")}`,
  `${plural(inventory.slackMessages, "Slack message")} and ${plural(inventory.slackReactions, "reaction")} of theirs the bot kept, with what it decided about them`,
  `${plural(inventory.clips, "spoken line")} in ${plural(inventory.recordingsSpokenIn, "recording")}, with ${plural(inventory.audioFiles, "audio file")}; each of those recordings gets a new transcript, summary and action items without them`,
  `${plural(inventory.recordingsStartedStoppedOrPaused, "recording")} they started, stopped or paused, ${plural(inventory.recordingRequests, "recording request")} and ${plural(inventory.recordingEdits, "edit")}, re-pointed at "${FORMER_MEMBER}"`,
  `${plural(inventory.actionItemsOwned, "action item")} they own, left without an owner`,
  inventory.names.length === 0
    ? "No name on record, so nothing to take out of other people's text"
    : `Their name (${Array.join(inventory.names, ", ")}) taken out of ${plural(inventory.linesMentioningThem, "other person's line", "other people's lines")}, ${plural(inventory.recordingTextsMentioningThem, "title, agenda, summary or action item", "titles, agendas, summaries and action items")}, ${plural(inventory.slackPostsMentioningThem, "of the bot's Slack posts", "of the bot's Slack posts")} and ${plural(inventory.slackMessagesMentioningThem, "other Slack message")}, in the database and in Slack`,
  "Their membership and consent history, keeping one row with no personal data as proof",
];

const whoIs = (erasure: ErasureCase, markup: Markup) =>
  markup === "discord"
    ? `${erasure.displayName ?? "A member"} (<@${erasure.userId}>)`
    : `${erasure.displayName ?? "A member"} (Discord ID ${erasure.userId})`;

export const adminNotice = (erasure: ErasureCase, markup: Markup): string =>
  Array.join(
    [
      bold(markup, "Someone asked for their data to be deleted"),
      `${whoIs(erasure, markup)} asked on ${formatDay(erasure.requestedAt)} for everything the office holds about them to be deleted. Under Article 17 of the GDPR that's their right, and it follows from withdrawing consent, which took effect when they asked: they're out of the office and nothing new is recorded about them.`,
      `${bold(markup, `Unless someone acts, it's deleted on ${formatDay(erasure.dueAt)}.`)} That's the month the GDPR gives us, and it's there to check whether anything has to be kept, not to wait.`,
      bold(markup, "What will be deleted"),
      list(markup, describeInventory(erasure.inventory)),
      bold(markup, "What you can do"),
      list(markup, [
        `${bold(markup, DELETE_NOW_LABEL)} runs it within a minute.`,
        `${bold(markup, LET_IT_RUN_LABEL)} only notes that you've seen it.`,
        `${bold(markup, "Refuse")} needs one of the two grounds the GDPR allows here: ${REFUSAL_GROUNDS.legal_obligation}, or ${REFUSAL_GROUNDS.legal_claim}. You'll be asked for a reason, which goes to them word for word, together with their right to complain to a data protection authority. Nothing else is a reason.`,
      ]),
      `You can also act from the Console's Privacy tab. Request #${erasure.id}.`,
    ],
    "\n\n",
  );

export type AdminOutcome = "now" | "refused" | "cancelled" | "erased";

export const adminSettled = (
  erasure: ErasureCase,
  outcome: AdminOutcome,
  by: Option.Option<string>,
  markup: Markup,
): string => {
  const who = Option.getOrElse(by, () => "An admin");

  switch (outcome) {
    case "now":
      return `${adminNotice(erasure, markup)}\n\n${bold(markup, `${who} asked for it to be deleted now.`)} The bot is on it.`;
    case "refused":
      return Array.join(
        [
          bold(markup, `Deletion request #${erasure.id} refused`),
          `${who} refused ${whoIs(erasure, markup)}'s request on ${formatDay(erasure.requestedAt)} because of ${REFUSAL_GROUNDS[erasure.refusal?.ground ?? "legal_obligation"]}: "${erasure.refusal?.reason ?? ""}". Their data stays, their consent stays withdrawn, and they've been told why and that they can complain.`,
        ],
        "\n\n",
      );
    case "cancelled":
      return Array.join(
        [
          bold(markup, `Deletion request #${erasure.id} cancelled`),
          `${whoIs(erasure, markup)} cancelled their request, or agreed to being recorded again. Nothing was deleted.`,
        ],
        "\n\n",
      );
    case "erased":
      return Array.join(
        [
          bold(markup, `Deletion request #${erasure.id} done`),
          `Everything was deleted on ${formatDay(DateTime.nowUnsafe())}, and their name is taken out of what's left, this message included.`,
        ],
        "\n\n",
      );
  }
};
