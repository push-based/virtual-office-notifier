import { Array, Duration } from "effect";
import type { Wording } from "recording-requests/Consent";
import { CONSENT_ANSWER_MS, RECORDED_IN_THE_OFFICE } from "recording-requests/wire";

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

export const SHOWN_OUT_REASON = "Didn't agree to being recorded in the office";
