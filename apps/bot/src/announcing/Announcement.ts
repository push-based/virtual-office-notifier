import { DateTime, Option, pipe, String } from "effect";

import { OfficeEvent, type OfficeLocation, type SessionRecap } from "../OfficeEvent.ts";
import {
  type ActionsBlock,
  AI_DISCLAIMER,
  context,
  escapeSlackText,
  formatDuration,
  headline,
  mrkdwn,
  type SectionBlock,
  type SlackMessage,
} from "../slack/index.ts";

const joinLink = (office: OfficeLocation): string =>
  `https://discord.com/channels/${office.guildId}/${office.channelId}`;

export type Variants = readonly [string, ...Array<string>];

const pick = (variants: Variants, variant: number): string =>
  variants[Math.abs(variant) % variants.length] ?? variants[0];

export const openedHeadlines = (name: string): Variants => [
  `🎙️ ${name} opened the virtual office — everyone's welcome to join!`,
  `☕ ${name} just walked into the virtual office. Come say hi!`,
  `🚪 The virtual office is open and ${name} is in. Pull up a chair!`,
];

export const JOIN_LABEL = "🎧 Join the office";

export const JUMP_IN_LABEL = "🎧 Jump in";

export const emptiedHeadlines: Variants = [
  "🪑 The virtual office is empty right now — jump in and get it going!",
  "🌙 Everyone's headed out of the virtual office. Be the first one back!",
  "💤 The virtual office has gone quiet. Drop in and wake it up!",
];

export const reminderHeadlines: Variants = [
  "⏰ Daily reminder: come hang out in the virtual office!",
  "⏰ It's virtual office o'clock — come work alongside us!",
  "⏰ Friendly nudge: the virtual office is better with you in it!",
  "🪴 The office plant is lonely. It's been talking to itself again. Come keep it company!",
  "☕ The virtual coffee is fresh, free, and calorie-free. No excuses — come grab a cup!",
  "🦗 Crickets in the virtual office. Crickets are terrible coworkers. Come replace them!",
  "🎧 Studies show* working next to people is 73% less lonely. *We made that up. Join anyway!",
  "🧑‍💻 Your rubber duck called. It says it wants to meet the team. Bring it to the virtual office!",
  "🍩 Rumour has it there are virtual donuts in the office. They're not real, but the company is!",
  "📢 Mandatory fun is not mandatory. But it is fun. See you in the virtual office?",
  "🐛 Bugs are easier to squash as a team. Bring yours to the virtual office!",
  "🪑 We saved you a seat in the virtual office. Someone keeps trying to sit in it. Hurry!",
  "🔇 You can stay on mute. We just like knowing you're there. Come hang out!",
  "🚀 Productivity is contagious. Come catch some in the virtual office!",
  "🙈 Nobody will see your messy desk. Cameras optional — come hang out!",
  "🧃 Hydration check! Grab a drink and bring it to the virtual office.",
  "🕵️ We noticed you're not in the virtual office. We're not mad, just disappointed. Come on in!",
  "🎲 Today's forecast: 100% chance of good company in the virtual office.",
];

export const banterExamples: Variants = [
  "🐦 Sam has been first into the office every single day this week. At this point the chairs are setting themselves out for Sam.",
  "🎙️ Priya has muted and unmuted 14 times today. Either a very dramatic debate or a very persistent dog.",
  "🦗 Not a single visitor in the virtual office today. The chairs have started a book club. It's going badly.",
  "📸 Jo's camera made a rare 3-minute appearance on Tuesday. Scientists are still studying the footage.",
  "👯 Kai and Noor have turned up within five minutes of each other three days running. Coincidence? The office has its theories.",
];

const DAY_MS = 24 * 60 * 60 * 1000;

// Counts Mondays to Fridays since the epoch, so consecutive weekdays get
// consecutive numbers. A weekend day shares its number with the Monday after.
export const weekdaysSinceEpoch = (at: DateTime.Utc): number => {
  // The epoch was a Thursday; shifting by 3 lines the weeks up on Monday.
  const days = Math.floor(DateTime.toEpochMillis(at) / DAY_MS) + 3;

  return Math.floor(days / 7) * 5 + Math.min(days % 7, 5);
};

const people = (count: number): string => `${count} ${count === 1 ? "person" : "people"}`;

// Renders in each reader's own time zone; the fallback is for clients that can't.
const slackTime = (at: DateTime.Utc): string =>
  `<!date^${DateTime.toEpochSeconds(at)}^{time}|${pipe(DateTime.formatIso(at), String.slice(11, 16))} UTC>`;

const joinButton = (office: OfficeLocation, label: string): ActionsBlock => ({
  type: "actions",
  elements: [
    {
      type: "button",
      text: { type: "plain_text", text: label, emoji: true },
      url: joinLink(office),
      style: "primary",
    },
  ],
});

const recapFields = (recap: SessionRecap): SectionBlock => ({
  type: "section",
  fields: [
    mrkdwn(`*Open for*\n${formatDuration(recap.duration)}`),
    mrkdwn(`*Stopped by*\n${people(recap.visitors)}`),
  ],
});

export const NAME_PLACEHOLDER = "{name}";

export interface GeneratedHeadline {
  // For an opened office, has NAME_PLACEHOLDER where the opener's name goes.
  readonly template: string;
  readonly button: string;
  readonly model: string;
}

const asLiteralReplacement = String.replaceAll("$", "$$$$");

// The model's output isn't trusted, so it's escaped; the name already is.
const headlineText = (
  generated: Option.Option<GeneratedHeadline>,
  fixed: () => string,
  name = "",
): string =>
  Option.match(generated, {
    onNone: fixed,
    onSome: ({ template }) =>
      pipe(escapeSlackText(template), String.replace(NAME_PLACEHOLDER, asLiteralReplacement(name))),
  });

const buttonLabel = (generated: Option.Option<GeneratedHeadline>, fixed: string): string =>
  Option.match(generated, { onNone: () => fixed, onSome: ({ button }) => button });

const credit = (generated: Option.Option<GeneratedHeadline>): Option.Option<string> =>
  Option.map(generated, ({ model }) => `✨ Headline by ${escapeSlackText(model)}`);

const banterMessage = (
  office: OfficeLocation,
  { template, button, model }: GeneratedHeadline,
): SlackMessage => {
  const text = escapeSlackText(template);

  return {
    text,
    blocks: [
      headline(text, Option.none()),
      joinButton(office, button),
      context(`✨ Banter by ${escapeSlackText(model)}`, AI_DISCLAIMER),
    ],
  };
};

// `variant` picks one of the fixed phrasings, so repeated posts don't all read
// the same. Reminders ignore it and rotate by date instead, so every phrasing
// comes up once before any repeats.
export const formatMessage = (
  event: OfficeEvent,
  variant: number,
  generated: Option.Option<GeneratedHeadline> = Option.none(),
): Option.Option<SlackMessage> =>
  OfficeEvent.$match(event, {
    Opened: (member) => {
      const name = `*${escapeSlackText(member.displayName)}*`;
      const text = headlineText(generated, () => pick(openedHeadlines(name), variant), name);

      const avatar = Option.map(Option.fromNullOr(member.avatarUrl), (url) => ({
        url,
        name: member.displayName,
      }));

      return Option.some({
        text,
        blocks: [
          headline(text, avatar),
          joinButton(member, buttonLabel(generated, JOIN_LABEL)),
          context(
            `🔊 Opened on Discord at ${slackTime(member.at)}`,
            ...Option.toArray(credit(generated)),
          ),
        ],
      });
    },
    Emptied: (member) => {
      const text = headlineText(generated, () => pick(emptiedHeadlines, variant));

      return Option.some({
        text,
        blocks: [
          headline(text, Option.none()),
          ...Option.match(member.recap, {
            onNone: () => [],
            onSome: (recap) => [recapFields(recap)],
          }),
          joinButton(member, buttonLabel(generated, JUMP_IN_LABEL)),
          context(`🔇 Emptied at ${slackTime(member.at)}`, ...Option.toArray(credit(generated))),
        ],
      });
    },
    Reminder: (office) => {
      const text = headlineText(generated, () =>
        pick(reminderHeadlines, weekdaysSinceEpoch(office.at)),
      );

      return Option.some({
        text,
        blocks: [
          headline(text, Option.none()),
          joinButton(office, buttonLabel(generated, JOIN_LABEL)),
          ...Option.toArray(Option.map(credit(generated), context)),
        ],
      });
    },
    Banter: (office) => Option.map(generated, (written) => banterMessage(office, written)),
  });
