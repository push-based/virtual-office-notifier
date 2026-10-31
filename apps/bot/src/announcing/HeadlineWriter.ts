import {
  Array,
  Context,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  type Option,
  pipe,
  Random,
  Schema,
  SchemaTransformation,
  String,
} from "effect";

import {
  type Brief,
  orReportedNone,
  type Providers,
  unquoted,
  writerLayer,
  writeWithProviders,
} from "../ai/index.ts";
import { banterLog } from "./Banter.ts";
import { OfficeEvent } from "../office/index.ts";
import {
  banterExamples,
  emptiedHeadlines,
  type GeneratedHeadline,
  JOIN_LABEL,
  JUMP_IN_LABEL,
  NAME_PLACEHOLDER,
  openedHeadlines,
  reminderHeadlines,
  type Variants,
} from "./Announcement.ts";

// One line with no Slack link or mention syntax. Models like to wrap a line in
// quotes.
const Line = (minLength: number, maxLength: number, pattern: RegExp) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(
        Schema.isMinLength(minLength),
        Schema.isMaxLength(maxLength),
        Schema.isPattern(pattern),
      ),
      unquoted,
    ),
  );

// The headline on the first line and the button label on the second.
const ReplyWith = (headline: ReturnType<typeof Line>) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (text): ReadonlyArray<string> =>
          pipe(
            text,
            String.split("\n"),
            Array.filter((line) => String.trim(line) !== ""),
          ),
        encode: (lines) => Array.join(lines, "\n"),
      }),
    ),
    Schema.decodeTo(
      Schema.Tuple([headline, Line(3, 30, /^[^{}<>]+$/)]),
      SchemaTransformation.passthroughSupertype(),
    ),
  );

export const OpenedReply = ReplyWith(Line(10, 160, /^[^{}<>]*\{name\}[^{}<>]*$/));

export const UnnamedReply = ReplyWith(Line(10, 160, /^[^{}<>]+$/));

export const BanterReply = ReplyWith(Line(10, 300, /^[^{}<>]+$/));

// Reported once every model has failed, so a run of fixed headlines shows up
// in Sentry. `reason` is why the last model failed.
export class NoAiHeadline extends Schema.TaggedError<
  NoAiHeadline,
  { readonly brand: unique symbol }
>()("NoAiHeadline", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `No AI model could write a headline, the last failed with ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

type HeadlineBrief = Brief<readonly [string, string]>;

const announcement = (
  task: string,
  examples: Variants,
  button: string,
  reply: typeof OpenedReply,
): HeadlineBrief => ({
  prompt: Array.join(
    [
      "You write one-line Slack announcements for a team's virtual office, a Discord voice channel where people work alongside each other.",
      task,
      "Reply with exactly two lines and nothing else: no quotes, no labels, no explanation, no markdown.",
      "Line 1 is the headline. Start it with a single fitting emoji and keep it under 120 characters.",
      `Line 2 is the label for the button that joins the office. Make it 2 to 4 words that play off the headline, start it with an emoji, and keep it under 30 characters. It used to always say "${button}".`,
      "Here are some past headlines. Match their tone, but write something new:",
      ...examples,
    ],
    "\n",
  ),
  request: "Write today's headline.",
  reply,
});

const BANTER_PROMPT = Array.join(
  [
    "You write short, playful Slack messages for a team's virtual office, a Discord voice channel where people work alongside each other.",
    "You'll get a log of what happened in the office. Read all of it, pick the single most striking thing in it and write a message about it. It could be an early bird, a night owl, a marathon session, a mute and unmute frenzy, everyone turning their cameras on at once, a rare camera appearance, a crowd, a lone regular, two people who keep turning up together, a soundboard spree, or an office nobody visited.",
    "In the log, Joined and Left are arriving and leaving, AlreadyThere means they were in when the log started, Muted and Unmuted are their own microphone, Deafened means they turned their sound off, ServerMuted means a moderator muted them, CameraOn is their camera, StreamStarted is sharing their screen, PlayedSound is a soundboard sound followed by its name, and Reacted is an emoji they sent in the voice channel.",
    "Get the facts right: only say what the log shows, with the right people, days, times and counts. If the log is from last week, say last week.",
    "Name people when it makes the message better, exactly as they're written in the log. Refer to people by name or as they, never as he or she.",
    "Tease gently and keep it warm: never be mean, and never shame anyone for being away, leaving early or how much they work.",
    "Reply with exactly two lines and nothing else: no quotes, no labels, no explanation, no markdown.",
    "Line 1 is the message. Start it with a single fitting emoji and keep it to one or two sentences, under 250 characters.",
    "Line 2 is the label for the button that joins the office. Make it 2 to 4 words that play off the message, start it with an emoji, and keep it under 30 characters.",
    "Here are some example messages. Match their tone, but don't reuse their jokes:",
    ...banterExamples,
  ],
  "\n",
);

export const briefFor = OfficeEvent.$match({
  Opened: (): HeadlineBrief =>
    announcement(
      `Someone just opened the office. Write a short, warm, playful headline that says so and invites others to join. Refer to the person only as ${NAME_PLACEHOLDER}, exactly once.`,
      openedHeadlines(NAME_PLACEHOLDER),
      JOIN_LABEL,
      OpenedReply,
    ),
  Emptied: (): HeadlineBrief =>
    announcement(
      "Everyone just left the office, so it's empty. Write a short, warm, playful headline that says so and invites people to jump back in. Don't name anyone.",
      emptiedHeadlines,
      JUMP_IN_LABEL,
      UnnamedReply,
    ),
  Reminder: (): HeadlineBrief =>
    announcement(
      "It's the weekday reminder. Write a short, funny headline inviting the team to come work alongside each other in the office. Don't name anyone.",
      reminderHeadlines,
      JOIN_LABEL,
      UnnamedReply,
    ),
  Banter: (context): HeadlineBrief => ({
    prompt: BANTER_PROMPT,
    request: banterLog(context),
    reply: BanterReply,
  }),
});

export class HeadlineWriter extends Context.Service<
  HeadlineWriter,
  {
    // None means the fixed phrasings should be used.
    write(event: OfficeEvent): Effect.Effect<Option.Option<GeneratedHeadline>>;
  }
>()("bot/announcing/HeadlineWriter") {
  // Either provider may go first, and its models are tried in turn until one
  // writes a usable headline.
  static readonly layerProviders = (providers: Providers, banterProviders: Providers = providers) =>
    Layer.succeed(
      HeadlineWriter,
      HeadlineWriter.of({
        write: Effect.fn("HeadlineWriter.write")(
          function* (event: OfficeEvent) {
            const candidates = OfficeEvent.$is("Banter")(event) ? banterProviders : providers;
            const shuffled = (yield* Random.nextBoolean) ? candidates : Array.reverse(candidates);
            const { value, model } = yield* writeWithProviders(briefFor(event), shuffled);
            const [template, button] = value;

            return { template, button, model };
          },
          orReportedNone("write a headline", (reason) => NoAiHeadline.make({ reason })),
          (effect, event) => Effect.annotateLogs(effect, { headline: event._tag }),
        ),
      }),
    );

  static readonly layerFixed = Layer.succeed(
    HeadlineWriter,
    HeadlineWriter.of({ write: () => Effect.succeedNone }),
  );

  static readonly layer = writerLayer({
    withProviders: ({ headlines, banter }) => HeadlineWriter.layerProviders(headlines, banter),
    withoutProviders: HeadlineWriter.layerFixed,
    withoutProvidersNote: "No AI provider configured, so using the fixed headlines",
  });
}
