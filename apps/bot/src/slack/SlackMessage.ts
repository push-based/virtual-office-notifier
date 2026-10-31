import { Array, Duration, Option, pipe, String } from "effect";

// Slack treats &, < and > as control characters in message text. Escaping them
// stops a nickname like `<!channel>` from pinging everyone.
export const escapeSlackText = (text: string): string =>
  pipe(
    text,
    String.replaceAll("&", "&amp;"),
    String.replaceAll("<", "&lt;"),
    String.replaceAll(">", "&gt;"),
  );

// The subset of Slack's Block Kit these messages use.
export interface Mrkdwn {
  readonly type: "mrkdwn";
  readonly text: string;
}

interface Image {
  readonly type: "image";
  readonly image_url: string;
  readonly alt_text: string;
}

interface LinkButton {
  readonly type: "button";
  readonly text: { readonly type: "plain_text"; readonly text: string; readonly emoji: boolean };
  readonly url: string;
  readonly style: "primary";
}

export interface SectionBlock {
  readonly type: "section";
  readonly text?: Mrkdwn;
  readonly fields?: ReadonlyArray<Mrkdwn>;
  readonly accessory?: Image;
}

export interface ActionsBlock {
  readonly type: "actions";
  readonly elements: ReadonlyArray<LinkButton>;
}

export interface ContextBlock {
  readonly type: "context";
  readonly elements: ReadonlyArray<Mrkdwn>;
}

type Block = SectionBlock | ActionsBlock | ContextBlock;

// `text` is what notifications and older clients show; `blocks` is the card.
export interface SlackMessage {
  readonly text: string;
  readonly blocks: ReadonlyArray<Block>;
}

export const formatDuration = (duration: Duration.Duration): string => {
  const totalMinutes = Math.floor(Duration.toMinutes(duration));

  if (totalMinutes < 1) return "under a minute";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes}m`;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};

export const mrkdwn = (text: string): Mrkdwn => ({ type: "mrkdwn", text });

export const headline = (
  text: string,
  avatar: Option.Option<{ readonly url: string; readonly name: string }>,
): SectionBlock => ({
  type: "section",
  text: mrkdwn(text),
  ...Option.match(avatar, {
    onNone: () => ({}),
    onSome: ({ url, name }) => ({ accessory: { type: "image", image_url: url, alt_text: name } }),
  }),
});

export const context = (...texts: ReadonlyArray<string>): ContextBlock => ({
  type: "context",
  elements: Array.map(texts, mrkdwn),
});

export const AI_DISCLAIMER = "🤖 AI is a hallucination machine.";
