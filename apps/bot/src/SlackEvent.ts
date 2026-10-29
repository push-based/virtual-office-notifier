import { Data, Match, Option, Schema } from "effect";

const AppMention = Schema.Struct({
  type: Schema.Literal("app_mention"),
  channel: Schema.String,
  user: Schema.String,
  text: Schema.String,
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
});

const Message = Schema.Struct({
  type: Schema.Literal("message"),
  channel: Schema.String,
  ts: Schema.String,
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thread_ts: Schema.optional(Schema.String),
  parent_user_id: Schema.optional(Schema.String),
});

const Reaction = Schema.Struct({
  type: Schema.Literals(["reaction_added", "reaction_removed"]),
  user: Schema.String,
  reaction: Schema.String,
  item_user: Schema.optional(Schema.String),
  item: Schema.Struct({
    type: Schema.String,
    channel: Schema.optional(Schema.String),
    ts: Schema.optional(Schema.String),
  }),
  event_ts: Schema.String,
});

const SlackEventPayload = Schema.Union([AppMention, Message, Reaction]);

export type SlackEventPayload = typeof SlackEventPayload.Type;

const RawEnvelope = Schema.Struct({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  retry_attempt: Schema.optional(Schema.Int),
  payload: Schema.optional(Schema.Struct({ event: Schema.optional(Schema.Json) })),
});

const decodeRawEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(RawEnvelope));

const decodeEvent = Schema.decodeUnknownOption(SlackEventPayload);

export interface Envelope {
  readonly type: string;
  readonly envelopeId: Option.Option<string>;
  readonly retryAttempt: number;
  readonly event: Option.Option<SlackEventPayload>;
}

export const decodeEnvelope = (text: string): Option.Option<Envelope> =>
  Option.map(
    decodeRawEnvelope(text),
    (raw): Envelope => ({
      type: raw.type,
      envelopeId: Option.fromUndefinedOr(raw.envelope_id),
      retryAttempt: raw.retry_attempt ?? 0,
      event: Option.flatMap(Option.fromUndefinedOr(raw.payload?.event), decodeEvent),
    }),
  );

export type SlackActivity = Data.TaggedEnum<{
  Message: {
    readonly channel: string;
    readonly ts: string;
    readonly threadTs: string;
    readonly userId: string;
    readonly text: string;
    readonly isMention: boolean;
  };
  Reaction: {
    readonly channel: string;
    readonly itemTs: string;
    readonly userId: string;
    readonly emoji: string;
    readonly added: boolean;
    readonly eventTs: string;
  };
}>;

export const SlackActivity = Data.taggedEnum<SlackActivity>();

export interface ActivityContext {
  readonly botUserId: string;
  readonly officeChannelId: string;
}

const mentions = (text: string, botUserId: string): boolean => text.includes(`<@${botUserId}>`);

const mentionActivity = (event: typeof AppMention.Type, context: ActivityContext): Option.Option<SlackActivity> =>
  event.channel === context.officeChannelId && event.user !== context.botUserId
    ? Option.some(
        SlackActivity.Message({
          channel: event.channel,
          ts: event.ts,
          threadTs: event.thread_ts ?? event.ts,
          userId: event.user,
          text: event.text,
          isMention: true,
        }),
      )
    : Option.none();

const threadReplyActivity = (event: typeof Message.Type, context: ActivityContext): Option.Option<SlackActivity> => {
  const { user, thread_ts: threadTs, text = "" } = event;

  const eligible =
    event.channel === context.officeChannelId &&
    event.subtype === undefined &&
    event.bot_id === undefined &&
    user !== undefined &&
    user !== context.botUserId &&
    threadTs !== undefined &&
    threadTs !== event.ts &&
    event.parent_user_id === context.botUserId &&
    !mentions(text, context.botUserId);

  return eligible
    ? Option.some(
        SlackActivity.Message({ channel: event.channel, ts: event.ts, threadTs, userId: user, text, isMention: false }),
      )
    : Option.none();
};

const reactionActivity = (event: typeof Reaction.Type, context: ActivityContext): Option.Option<SlackActivity> => {
  const { channel, ts } = event.item;

  const eligible =
    event.item.type === "message" &&
    channel === context.officeChannelId &&
    ts !== undefined &&
    event.item_user === context.botUserId &&
    event.user !== context.botUserId;

  return eligible
    ? Option.some(
        SlackActivity.Reaction({
          channel,
          itemTs: ts,
          userId: event.user,
          emoji: event.reaction,
          added: event.type === "reaction_added",
          eventTs: event.event_ts,
        }),
      )
    : Option.none();
};

export const eligibleActivity = (envelope: Envelope, context: ActivityContext): Option.Option<SlackActivity> =>
  Option.flatMap(envelope.event, (event) =>
    Match.value(event).pipe(
      Match.discriminatorsExhaustive("type")({
        app_mention: (mention) => mentionActivity(mention, context),
        message: (message) => threadReplyActivity(message, context),
        reaction_added: (reaction) => reactionActivity(reaction, context),
        reaction_removed: (reaction) => reactionActivity(reaction, context),
      }),
    ),
  );
