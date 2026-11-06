import { joinVoiceChannel } from "@discordjs/voice";
import {
  Array,
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  FiberSet,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
  String as Text,
} from "effect";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  GatewayOpcodes,
  type Guild,
  type GuildMember,
  type Interaction,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  Routes,
  Status,
  type VoiceBasedChannel,
  type VoiceChannelEffect,
  type VoiceState,
} from "discord.js";
import type { PersonInOffice } from "recording-requests/RecordingRequest";

import {
  type Choice,
  type ConsentAnswer,
  ConsentGate,
  type ConsentLine,
  type Gate,
  Notice,
  type PromptDelivery,
} from "../consent/index.ts";

import { type BotPresence, presenceAfter, presenceAtStartup } from "./BotPresence.ts";
import { DiscordConfig } from "../Config.ts";
import type { SeatAdapter } from "./OfficeSeat.ts";
import { type OfficeVoice, officeVoiceIn } from "./OfficeVoice.ts";
import {
  isOfficeJoin,
  isOfficeLeave,
  NO_VOICE_DETAILS,
  type OfficeEvent,
  type OfficeLocation,
  type OfficeSession,
  type Occupants,
  sessionOf,
  type TimedVoiceStateUpdate,
  trackOccupancy,
  type VoiceDetails,
  type VoiceStateUpdate,
} from "./OfficeEvent.ts";
import { sentInOffice, type TimedVoiceEffect, type VoiceEffect } from "./VoiceEffect.ts";
import { observe, type VoiceObservation } from "./VoiceObservation.ts";

export class DiscordLoginError extends Schema.TaggedError<
  DiscordLoginError,
  { readonly brand: unique symbol }
>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

const stamped = <A extends VoiceStateUpdate | VoiceEffect, E, R>(updates: Stream.Stream<A, E, R>) =>
  updates.pipe(
    Stream.mapEffect((update) => DateTime.now.pipe(Effect.map((at) => ({ ...update, at })))),
  );

interface Followed {
  readonly update: TimedVoiceStateUpdate;
  readonly events: ReadonlyArray<OfficeEvent>;
}

const REPLAYED_UPDATES = 1000;

const followOffice =
  (officeChannelId: string, occupants: Occupants) =>
  <R>(updates: Stream.Stream<TimedVoiceStateUpdate, never, R>) =>
    updates.pipe(
      Stream.mapAccum(
        () => sessionOf(occupants),
        (session, update): readonly [OfficeSession, ReadonlyArray<Followed>] => {
          const [next, events] = trackOccupancy(officeChannelId)(session, update);

          return [next, [{ update, events }]];
        },
      ),
      Stream.broadcast({ capacity: "unbounded", replay: REPLAYED_UPDATES }),
      Effect.map((followed) => ({
        updates: followed.pipe(Stream.map(({ update }) => update)),
        officeEvents: followed.pipe(
          Stream.map(({ events }) => events),
          Stream.flattenIterable,
        ),
      })),
    );

// Starts with whoever was already in the office at startup, then follows every
// update touching it.
const voiceObservations =
  (officeChannelId: string, present: ReadonlyArray<VoiceStateUpdate>) =>
  <E, R>(
    updates: Stream.Stream<TimedVoiceStateUpdate, E, R>,
  ): Stream.Stream<VoiceObservation, E, R> =>
    stamped(Stream.fromIterable(present)).pipe(
      Stream.map((update): VoiceObservation => ({ ...update, source: "startup", officeChannelId })),
      Stream.concat(updates.pipe(Stream.filterMap(observe(officeChannelId)))),
    );

const fromOthers =
  (selfId: string) =>
  <A extends { readonly userId: string }, E, R>(
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.filter((item) => item.userId !== selfId));

const officeEffects =
  (officeChannelId: string) =>
  <E, R>(effects: Stream.Stream<VoiceEffect, E, R>): Stream.Stream<TimedVoiceEffect, E, R> =>
    stamped(effects).pipe(Stream.filterMap(sentInOffice(officeChannelId)));

const botPresence = <E, R>(occupants: Occupants, events: Stream.Stream<OfficeEvent, E, R>) =>
  Stream.make(presenceAtStartup(occupants)).pipe(
    Stream.concat(events.pipe(Stream.filterMap(presenceAfter))),
  );

const detailsOf = (state: VoiceState): VoiceDetails => ({
  selfMute: state.selfMute,
  selfDeaf: state.selfDeaf,
  serverMute: state.serverMute,
  serverDeaf: state.serverDeaf,
  selfVideo: state.selfVideo,
  streaming: state.streaming,
  suppress: state.suppress,
  requestToSpeakAt:
    state.requestToSpeakTimestamp === null
      ? null
      : DateTime.makeUnsafe(state.requestToSpeakTimestamp),
  sessionId: state.sessionId,
});

const memberOf = (state: VoiceState) => ({
  userId: state.id,
  displayName: state.member?.displayName ?? state.id,
  // Slack can't show Discord's default WebP avatars.
  avatarUrl: state.member?.displayAvatarURL({ extension: "png", size: 128 }) ?? null,
  guildId: state.guild.id,
  isBot: state.member?.user.bot ?? false,
});

const toVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): VoiceStateUpdate => ({
  ...memberOf(newState),
  oldChannelId: oldState.channelId,
  newChannelId: newState.channelId,
  oldDetails: detailsOf(oldState),
  newDetails: detailsOf(newState),
});

// Someone already in the office at startup, as if they had just joined.
const alreadyPresent = (member: GuildMember): VoiceStateUpdate => ({
  ...memberOf(member.voice),
  oldChannelId: null,
  newChannelId: member.voice.channelId,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: detailsOf(member.voice),
});

const occupantOfUpdate = (update: VoiceStateUpdate): PersonInOffice => ({
  userId: update.userId,
  displayName: update.displayName,
  avatarUrl: update.avatarUrl,
});

const listenToVoiceStates = Effect.fnUntraced(function* (client: Client) {
  const updates = yield* Queue.unbounded<VoiceStateUpdate>();

  const onUpdate = (oldState: VoiceState, newState: VoiceState) => {
    Queue.offerUnsafe(updates, toVoiceStateUpdate(oldState, newState));
  };

  yield* Effect.acquireRelease(
    Effect.sync(() => client.on(Events.VoiceStateUpdate, onUpdate)),
    () => Effect.sync(() => client.off(Events.VoiceStateUpdate, onUpdate)),
  );

  return updates;
});

type DefaultSoundNames = ReadonlyMap<string, string>;

const soundNameOf = (
  effect: VoiceChannelEffect,
  defaultSounds: DefaultSoundNames,
): string | null => {
  if (effect.soundId === null) return null;

  const soundId = String(effect.soundId);

  return (
    effect.guild.soundboardSounds.cache.get(soundId)?.name ?? defaultSounds.get(soundId) ?? null
  );
};

const toVoiceEffect = (
  effect: VoiceChannelEffect,
  defaultSounds: DefaultSoundNames,
): VoiceEffect => {
  const member = effect.guild.members.cache.get(effect.userId);

  return {
    userId: effect.userId,
    displayName: member?.displayName ?? effect.userId,
    isBot: member?.user.bot ?? false,
    guildId: effect.guild.id,
    channelId: effect.channelId,
    soundId: effect.soundId === null ? null : String(effect.soundId),
    soundName: soundNameOf(effect, defaultSounds),
    soundVolume: effect.soundVolume,
    emojiId: effect.emoji?.id ?? null,
    emojiName: effect.emoji?.name ?? null,
    emojiAnimated: effect.emoji?.animated ?? null,
    animationType: effect.animationType,
    animationId: effect.animationId,
  };
};

const voiceEffects = (client: Client, defaultSounds: DefaultSoundNames) =>
  Stream.callback<VoiceEffect>(
    Effect.fnUntraced(function* (queue) {
      const onEffect = (effect: VoiceChannelEffect) => {
        Queue.offerUnsafe(queue, toVoiceEffect(effect, defaultSounds));
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => client.on(Events.VoiceChannelEffectSend, onEffect)),
        () => Effect.sync(() => client.off(Events.VoiceChannelEffectSend, onEffect)),
      );
    }),
  );

const decodeDefaultSounds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sound_id: Schema.String, name: Schema.String })),
);

const fetchDefaultSoundNames = (client: Client<true>) =>
  Effect.tryPromise(() => client.rest.get(Routes.soundboardDefaultSounds())).pipe(
    Effect.flatMap(decodeDefaultSounds),
    Effect.map(
      (sounds): DefaultSoundNames =>
        new Map(Array.map(sounds, (sound) => [sound.sound_id, sound.name])),
    ),
    Effect.timeout(Duration.seconds(10)),
    Effect.catch((error) =>
      Effect.logWarning(
        "Couldn't fetch Discord's default soundboard sounds, so their names aren't recorded",
      ).pipe(
        Effect.annotateLogs({ reason: String(error) }),
        Effect.as<DefaultSoundNames>(new Map()),
      ),
    ),
  );

export class BotMoveError extends Schema.TaggedError<
  BotMoveError,
  { readonly brand: unique symbol }
>()("BotMoveError", {
  reason: Schema.String,
}) {}

const sendVoiceState = (guild: Guild, channelId: string | null) =>
  guild.shard.status === Status.Ready
    ? Effect.try({
        try: () =>
          guild.shard.send({
            op: GatewayOpcodes.VoiceStateUpdate,
            d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: true },
          }),
        catch: (cause) => BotMoveError.make({ reason: String(cause) }),
      })
    : Effect.fail(BotMoveError.make({ reason: "Discord isn't connected" }));

const shardReconnects = (client: Client) =>
  Stream.callback<void>(
    Effect.fnUntraced(function* (queue) {
      const onReconnect = () => {
        Queue.offerUnsafe(queue, undefined);
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          client.on(Events.ShardReady, onReconnect);
          client.on(Events.ShardResume, onReconnect);
        }),
        () =>
          Effect.sync(() => {
            client.off(Events.ShardReady, onReconnect);
            client.off(Events.ShardResume, onReconnect);
          }),
      );
    }),
  );

const setNickname = (guild: Guild, nickname: string | null) =>
  Effect.tryPromise(() => guild.members.me?.setNickname(nickname) ?? Promise.resolve(null)).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning(
        "Couldn't change the bot's nickname. Give it the Change Nickname permission.",
      ).pipe(Effect.annotateLogs({ reason: String(error) })),
    ),
  );

const occupantOf = (member: GuildMember): PersonInOffice => ({
  userId: member.id,
  displayName: member.displayName,
  avatarUrl: member.displayAvatarURL({ extension: "png", size: 128 }),
});

const CONSENT_PREFIX = "consent";

const ConsentButton = Schema.Tuple([
  Schema.Literal(CONSENT_PREFIX),
  Schema.String,
  Schema.String,
  Schema.Literals(["agree", "decline"]),
]);

const decodeConsentButton = Schema.decodeUnknownOption(ConsentButton);

const consentButtonId = (promptId: string, userId: string, choice: Choice) =>
  Array.join([CONSENT_PREFIX, promptId, userId, choice], ":");

const consentButtons = (promptId: string, userId: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(consentButtonId(promptId, userId, "agree"))
      .setLabel(Notice.AGREE_LABEL)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(consentButtonId(promptId, userId, "decline"))
      .setLabel(Notice.DECLINE_LABEL)
      .setStyle(ButtonStyle.Secondary),
  );

const mentioning = (userId: string, text: string) => `<@${userId}>\n\n${text}`;

const NO_PINGS = { parse: [] };

const logFailure = (message: string) => (error: Error) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ reason: error.message }));

type RunFork = (effect: Effect.Effect<void>) => void;

const settled =
  (via: PromptDelivery["via"], userId: string) =>
  (message: Message): PromptDelivery => ({
    via,
    settle: (text) =>
      Effect.tryPromise(() =>
        message.edit({
          content: via === "voice_chat" ? mentioning(userId, text) : text,
          components: [],
          allowedMentions: NO_PINGS,
        }),
      ).pipe(Effect.asVoid, Effect.catch(logFailure("Couldn't update a consent question"))),
  });

const consentAnswers = (client: Client, runFork: RunFork) =>
  Stream.callback<ConsentAnswer>(
    Effect.fnUntraced(function* (queue) {
      const onInteraction = (interaction: Interaction) => {
        if (!interaction.isButton()) return;

        const button = decodeConsentButton(Text.split(interaction.customId, ":"));

        if (Option.isNone(button)) return;

        const [, promptId, userId, choice] = button.value;

        if (interaction.user.id !== userId) {
          runFork(
            Effect.tryPromise(() =>
              interaction.reply({ content: Notice.NOT_YOURS, flags: MessageFlags.Ephemeral }),
            ).pipe(Effect.catch(logFailure("Couldn't answer a button meant for someone else"))),
          );

          return;
        }

        Queue.offerUnsafe(queue, {
          promptId,
          userId,
          choice,
          reply: (text) =>
            Effect.tryPromise(() =>
              interaction.update({
                content: interaction.inGuild() ? mentioning(userId, text) : text,
                components: [],
                allowedMentions: NO_PINGS,
              }),
            ).pipe(Effect.asVoid, Effect.catch(logFailure("Couldn't answer a consent button"))),
        });
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => client.on(Events.InteractionCreate, onInteraction)),
        () => Effect.sync(() => client.off(Events.InteractionCreate, onInteraction)),
      );
    }),
  );

const consentLineIn = (
  client: Client,
  channel: VoiceBasedChannel,
  runFork: RunFork,
): ConsentLine => {
  const ask = (userId: string, promptId: string, text: string) => {
    const components = [consentButtons(promptId, userId)];

    const directMessage = Effect.tryPromise(() =>
      client.users.send(userId, { content: text, components }),
    ).pipe(Effect.map(settled("direct_message", userId)));

    const inVoiceChat = Effect.tryPromise(() =>
      channel.send({
        content: mentioning(userId, text),
        components,
        allowedMentions: { users: [userId] },
      }),
    ).pipe(Effect.map(settled("voice_chat", userId)));

    return directMessage.pipe(
      Effect.catch((error) =>
        logFailure("Couldn't send the consent question as a DM, asking in the voice chat")(
          error,
        ).pipe(Effect.andThen(inVoiceChat)),
      ),
      Effect.asSome,
      Effect.catch((error) =>
        logFailure("Couldn't ask someone for consent")(error).pipe(
          Effect.as(Option.none<PromptDelivery>()),
        ),
      ),
    );
  };

  const tell = (userId: string, text: string) =>
    Effect.tryPromise(() => client.users.send(userId, { content: text })).pipe(
      Effect.asVoid,
      Effect.catch(logFailure("Couldn't send someone a DM about their consent")),
    );

  const showOut = (userId: string, reason: string) =>
    Effect.tryPromise(() => channel.guild.members.fetch(userId)).pipe(
      Effect.flatMap((member) =>
        member.voice.channelId === channel.id
          ? Effect.tryPromise(() => member.voice.disconnect(reason)).pipe(Effect.as(true))
          : Effect.succeed(false),
      ),
      Effect.catch((error) =>
        logFailure(
          "Couldn't show someone out of the office. Give the bot the Move Members permission.",
        )(error).pipe(Effect.as(false)),
      ),
    );

  return { ask, tell, showOut, answers: consentAnswers(client, runFork) };
};

const login = (client: Client, token: Redacted.Redacted<string>) =>
  Effect.callback<Client<true>, DiscordLoginError>((resume) => {
    client.once(Events.ClientReady, (ready) => resume(Effect.succeed(ready)));
    client.login(Redacted.value(token)).catch((cause: unknown) => {
      resume(Effect.fail(DiscordLoginError.make({ cause })));
    });
  });

export interface TestGateway {
  readonly updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>;
  readonly occupants?: Occupants;
  readonly guildId?: string;
  readonly present?: ReadonlyArray<VoiceStateUpdate>;
  readonly effects?: ReadonlyArray<VoiceEffect>;
  readonly moves?: Queue.Enqueue<BotPresence>;
  readonly selfId?: string;
  readonly gate?: Gate;
  readonly line?: ConsentLine;
}

export class DiscordGateway extends Context.Service<
  DiscordGateway,
  {
    readonly officeEvents: Stream.Stream<OfficeEvent>;
    // Everything to record about the office, from the same updates.
    readonly voiceObservations: Stream.Stream<VoiceObservation>;
    readonly voiceEffects: Stream.Stream<TimedVoiceEffect>;
    readonly botPresence: Stream.Stream<BotPresence>;
    readonly seat: Option.Option<SeatAdapter>;
    readonly occupants: Effect.Effect<ReadonlyArray<PersonInOffice>>;
    isAdmitted(userId: string): Effect.Effect<boolean>;
    readonly consentLine: Option.Option<ConsentLine>;
    readonly selfUserId: string;
    readonly voice: Option.Option<OfficeVoice>;
    // None when the office channel wasn't found at startup.
    readonly office: Option.Option<OfficeLocation>;
  }
>()("bot/office/DiscordGateway") {
  static readonly layer = Layer.effect(
    DiscordGateway,
    Effect.gen(function* () {
      const { botToken, officeChannelId } = yield* DiscordConfig;
      const gate = yield* ConsentGate;

      const runFork = yield* FiberSet.make().pipe(
        Effect.flatMap((callbacks) => FiberSet.runtime(callbacks)()),
      );

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client({
              intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildExpressions,
              ],
            }),
        ),
        (client) =>
          Effect.promise(() => client.destroy()).pipe(
            Effect.andThen(Effect.logInfo("Disconnected from Discord")),
          ),
      );

      // An EventEmitter "error" event with no listener would crash the process.
      client.on(Events.Error, (error) =>
        runFork(
          Effect.logError("Discord client error", error).pipe(
            Effect.andThen(ErrorReporter.report(Cause.fail(error))),
          ),
        ),
      );
      client.on(Events.Warn, (message) =>
        runFork(Effect.logWarning("Discord client warning", message)),
      );

      const ready = yield* login(client, botToken);

      const office = Option.fromUndefinedOr(ready.channels.cache.get(officeChannelId)).pipe(
        Option.filter((channel) => channel.isVoiceBased()),
      );

      yield* Effect.logInfo("Connected to Discord").pipe(
        Effect.annotateLogs({ user: ready.user.tag, guilds: ready.guilds.cache.size }),
      );

      const defaultSounds = yield* fetchDefaultSoundNames(ready);
      const heard = yield* listenToVoiceStates(client);

      // From the voice states Discord sends on connect.
      const inOffice = Option.match(office, {
        onNone: () => [],
        onSome: (channel) => [...channel.members.filter((member) => !member.user.bot).values()],
      });

      const consented = yield* gate.consentedAmong(Array.map(inOffice, (member) => member.id));

      const [present, waiting] = Array.partition(inOffice, (member) =>
        consented.has(member.id) ? Result.succeed(member) : Result.fail(member),
      );

      // Seeded from who's present, so restarting while people are in the office
      // doesn't announce it opening again.
      const occupants: Occupants = new Set(Array.map(present, (member) => member.id));

      // Keep running either way: the bot may be added to the server later.
      yield* Option.match(office, {
        onNone: () =>
          Effect.logWarning(
            "Office voice channel not found. Check DISCORD_OFFICE_CHANNEL_ID and that the bot is in the server and can view the channel.",
          ).pipe(Effect.annotateLogs({ officeChannelId, guilds: ready.guilds.cache.size })),
        onSome: (channel) =>
          Effect.logInfo("Found the office voice channel").pipe(
            Effect.annotateLogs({
              officeChannelId,
              officeChannel: channel.name,
              occupants: occupants.size,
            }),
            Effect.andThen(
              channel.permissionsFor(ready.user)?.has(PermissionFlagsBits.Connect) === true
                ? Effect.void
                : Effect.logWarning(
                    "The bot can't connect to the office voice channel, so soundboard sounds and emoji aren't recorded. Give it the Connect permission.",
                  ),
            ),
            Effect.andThen(
              channel.permissionsFor(ready.user)?.has(PermissionFlagsBits.MoveMembers) === true
                ? Effect.void
                : Effect.logWarning(
                    "The bot can't show people out of the office who don't agree to being recorded. Give it the Move Members permission.",
                  ),
            ),
          ),
      });

      const followed = yield* Stream.fromIterable(Array.map(waiting, alreadyPresent)).pipe(
        Stream.concat(Stream.fromQueue(heard)),
        fromOthers(ready.user.id),
        stamped,
        gate.admit(officeChannelId, occupants),
        followOffice(officeChannelId, occupants),
      );

      const voice = yield* Option.match(office, {
        onNone: () => Effect.succeed(Option.none<OfficeVoice>()),
        onSome: (channel) =>
          officeVoiceIn({
            guildId: channel.guild.id,
            channelId: officeChannelId,
            adapterCreator: channel.guild.voiceAdapterCreator,
            joinVoiceChannel,
            inVoice: Effect.sync(
              () => (channel.guild.members.me?.voice.channelId ?? null) !== null,
            ),
            stepOut: sendVoiceState(channel.guild, null).pipe(
              Effect.catchTag("BotMoveError", (error) =>
                Effect.logWarning("Couldn't step out of the office before joining").pipe(
                  Effect.annotateLogs({ reason: error.reason }),
                ),
              ),
            ),
          }).pipe(Effect.asSome),
      });

      const whoIsIn = Effect.sync((): ReadonlyArray<GuildMember> =>
        Option.match(office, {
          onNone: () => [],
          onSome: (channel) => [...channel.members.filter((member) => !member.user.bot).values()],
        }),
      ).pipe(
        Effect.flatMap((members) => Effect.filter(members, (member) => gate.isAdmitted(member.id))),
        Effect.map(Array.map(occupantOf)),
      );

      return DiscordGateway.of({
        officeEvents: followed.officeEvents,
        voiceObservations: followed.updates.pipe(
          voiceObservations(officeChannelId, Array.map(present, alreadyPresent)),
        ),
        voiceEffects: voiceEffects(client, defaultSounds).pipe(
          fromOthers(ready.user.id),
          officeEffects(officeChannelId),
          Stream.filterEffect((effect) => gate.isAdmitted(effect.userId)),
        ),
        botPresence: Option.match(office, {
          onNone: () => Stream.empty,
          onSome: () => botPresence(occupants, followed.officeEvents),
        }),
        seat: Option.flatMap(office, (channel) =>
          Option.map(voice, (officeVoice): SeatAdapter => ({
            join: officeVoice.join,
            leave: officeVoice.leave,
            rename: (nickname) => setNickname(channel.guild, nickname),
            reconnected: shardReconnects(client),
          })),
        ),
        occupants: whoIsIn,
        isAdmitted: gate.isAdmitted,
        consentLine: Option.map(office, (channel) => consentLineIn(client, channel, runFork)),
        selfUserId: ready.user.id,
        voice,
        office: Option.map(office, (channel) => ({
          guildId: channel.guild.id,
          channelId: officeChannelId,
        })),
      });
    }),
  );

  // Feeds the same shared occupancy tracking and observations from a queue, so
  // tests exercise everything but discord.js itself. `present` is who was in
  // the office at startup.
  static readonly layerTest = ({
    updates,
    occupants = new Set(),
    guildId = "guild",
    present = [],
    effects = [],
    moves,
    selfId = "self",
    gate = ConsentGate.open,
    line,
  }: TestGateway) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        const consented = yield* gate.consentedAmong(Array.map(present, (update) => update.userId));

        const [admitted, waiting] = Array.partition(present, (update) =>
          consented.has(update.userId) ? Result.succeed(update) : Result.fail(update),
        );

        const waitingIds = new Set(Array.map(waiting, (update) => update.userId));

        const seated: Occupants = new Set(
          Array.filter([...occupants], (userId) => !waitingIds.has(userId)),
        );

        const followed = yield* Stream.fromIterable(waiting).pipe(
          Stream.concat(Stream.fromQueue(updates)),
          fromOthers(selfId),
          stamped,
          gate.admit(officeChannelId, seated),
          followOffice(officeChannelId, seated),
        );

        const inOffice = yield* Ref.make<ReadonlyMap<string, PersonInOffice>>(
          new Map(Array.map(present, (update) => [update.userId, occupantOfUpdate(update)])),
        );

        yield* followed.updates.pipe(
          Stream.runForEach((update) =>
            Ref.update(inOffice, (members) => {
              const next = new Map(members);

              if (isOfficeJoin(officeChannelId, update))
                next.set(update.userId, occupantOfUpdate(update));

              if (isOfficeLeave(officeChannelId, update)) next.delete(update.userId);

              return next;
            }),
          ),
          Effect.forkScoped,
        );

        return DiscordGateway.of({
          officeEvents: followed.officeEvents,
          voiceObservations: followed.updates.pipe(voiceObservations(officeChannelId, admitted)),
          voiceEffects: Stream.fromIterable(effects).pipe(
            fromOthers(selfId),
            officeEffects(officeChannelId),
            Stream.filterEffect((effect) => gate.isAdmitted(effect.userId)),
          ),
          botPresence: botPresence(seated, followed.officeEvents),
          seat: Option.some({
            join: () =>
              moves === undefined
                ? Effect.void
                : Queue.offer(moves, "InOffice").pipe(Effect.asVoid),
            leave:
              moves === undefined ? Effect.void : Queue.offer(moves, "Away").pipe(Effect.asVoid),
            rename: () => Effect.void,
            reconnected: Stream.empty,
          }),
          occupants: Ref.get(inOffice).pipe(
            Effect.map((members) => [...members.values()]),
            Effect.flatMap((members) =>
              Effect.filter(members, (member) => gate.isAdmitted(member.userId)),
            ),
          ),
          isAdmitted: gate.isAdmitted,
          consentLine: Option.fromUndefinedOr(line),
          selfUserId: selfId,
          voice: Option.none(),
          office: Option.some({ guildId, channelId: officeChannelId }),
        });
      }),
    );
}
