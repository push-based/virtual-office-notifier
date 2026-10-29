import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import {
  Client,
  Events,
  GatewayIntentBits,
  GatewayOpcodes,
  type Guild,
  type GuildMember,
  PermissionFlagsBits,
  Routes,
  Status,
  type VoiceChannelEffect,
  type VoiceState,
} from "discord.js";
import type { Occupant } from "recording-requests/RecordingRequest";

import { type BotPresence, presenceAfter, presenceAtStartup } from "./BotPresence.ts";
import { DiscordConfig } from "./Config.ts";
import {
  isOfficeJoin,
  isOfficeLeave,
  NO_VOICE_DETAILS,
  type OfficeEvent,
  type OfficeLocation,
  type Occupants,
  sessionOf,
  trackOccupancy,
  type VoiceDetails,
  type VoiceStateUpdate,
} from "./OfficeEvent.ts";
import { sentInOffice, type TimedVoiceEffect, type VoiceEffect } from "./VoiceEffect.ts";
import { observe, type VoiceObservation } from "./VoiceObservation.ts";

export const RECORDING_NICKNAME = "🔴 Recording";

export class DiscordLoginError extends Schema.TaggedError<DiscordLoginError>()("DiscordLoginError", {
  cause: Schema.Defect(),
}) {}

const stamped = <A extends VoiceStateUpdate | VoiceEffect, E, R>(updates: Stream.Stream<A, E, R>) =>
  updates.pipe(Stream.mapEffect((update) => DateTime.now.pipe(Effect.map((at) => ({ ...update, at })))));

const officeEvents =
  (officeChannelId: string, occupants: Occupants) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<OfficeEvent, E, R> =>
    stamped(updates).pipe(Stream.mapAccum(() => sessionOf(occupants), trackOccupancy(officeChannelId)));

// Starts with whoever was already in the office at startup, then follows every
// update touching it.
const voiceObservations =
  (officeChannelId: string, present: ReadonlyArray<VoiceStateUpdate>) =>
  <E, R>(updates: Stream.Stream<VoiceStateUpdate, E, R>): Stream.Stream<VoiceObservation, E, R> =>
    stamped(Stream.fromIterable(present)).pipe(
      Stream.map((update): VoiceObservation => ({ ...update, source: "startup", officeChannelId })),
      Stream.concat(stamped(updates).pipe(Stream.filterMap(observe(officeChannelId)))),
    );

const fromOthers =
  (selfId: string) =>
  <A extends { readonly userId: string }, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.filter((item) => item.userId !== selfId));

const officeEffects =
  (officeChannelId: string) =>
  <E, R>(effects: Stream.Stream<VoiceEffect, E, R>): Stream.Stream<TimedVoiceEffect, E, R> =>
    stamped(effects).pipe(Stream.filterMap(sentInOffice(officeChannelId)));

const botPresence = <E, R>(occupants: Occupants, events: Stream.Stream<OfficeEvent, E, R>) =>
  Stream.make(presenceAtStartup(occupants)).pipe(Stream.concat(events.pipe(Stream.filterMap(presenceAfter))));

const detailsOf = (state: VoiceState): VoiceDetails => ({
  selfMute: state.selfMute,
  selfDeaf: state.selfDeaf,
  serverMute: state.serverMute,
  serverDeaf: state.serverDeaf,
  selfVideo: state.selfVideo,
  streaming: state.streaming,
  suppress: state.suppress,
  requestToSpeakAt: state.requestToSpeakTimestamp === null ? null : DateTime.makeUnsafe(state.requestToSpeakTimestamp),
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

const occupantOfUpdate = (update: VoiceStateUpdate): Occupant => ({
  userId: update.userId,
  displayName: update.displayName,
  avatarUrl: update.avatarUrl,
});

const voiceStateUpdates = (client: Client) =>
  Stream.callback<VoiceStateUpdate>(
    Effect.fnUntraced(function* (queue) {
      const onUpdate = (oldState: VoiceState, newState: VoiceState) => {
        Queue.offerUnsafe(queue, toVoiceStateUpdate(oldState, newState));
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => client.on(Events.VoiceStateUpdate, onUpdate)),
        () => Effect.sync(() => client.off(Events.VoiceStateUpdate, onUpdate)),
      );
    }),
  );

type DefaultSoundNames = ReadonlyMap<string, string>;

const soundNameOf = (effect: VoiceChannelEffect, defaultSounds: DefaultSoundNames): string | null => {
  if (effect.soundId === null) return null;

  const soundId = String(effect.soundId);

  return effect.guild.soundboardSounds.cache.get(soundId)?.name ?? defaultSounds.get(soundId) ?? null;
};

const toVoiceEffect = (effect: VoiceChannelEffect, defaultSounds: DefaultSoundNames): VoiceEffect => {
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
    Effect.map((sounds): DefaultSoundNames => new Map(sounds.map((sound) => [sound.sound_id, sound.name]))),
    Effect.timeout(Duration.seconds(10)),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't fetch Discord's default soundboard sounds, so their names aren't recorded").pipe(
        Effect.annotateLogs({ reason: String(error) }),
        Effect.as<DefaultSoundNames>(new Map()),
      ),
    ),
  );

export class BotMoveError extends Schema.TaggedError<BotMoveError>()("BotMoveError", {
  reason: Schema.String,
}) {}

const sendVoiceState = (guild: Guild, channelId: string | null, selfDeaf: boolean) =>
  guild.shard.status === Status.Ready
    ? Effect.try({
        try: () =>
          guild.shard.send({
            op: GatewayOpcodes.VoiceStateUpdate,
            d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: selfDeaf },
          }),
        catch: (cause) => new BotMoveError({ reason: String(cause) }),
      })
    : Effect.fail(new BotMoveError({ reason: "Discord isn't connected" }));

const moveBot = (guild: Guild, officeChannelId: string) => (presence: BotPresence) =>
  sendVoiceState(guild, presence === "InOffice" ? officeChannelId : null, true).pipe(
    Effect.andThen(Effect.logInfo("Moved the bot")),
    Effect.catchTag("BotMoveError", (error) =>
      Effect.logWarning("Couldn't move the bot").pipe(Effect.annotateLogs({ reason: error.reason })),
    ),
    Effect.annotateLogs({ presence }),
  );

const LEAVE_TIMEOUT = Duration.seconds(5);

const leaveForRecording = (guild: Guild) =>
  sendVoiceState(guild, null, true).pipe(
    Effect.andThen(
      Effect.sync(() => guild.members.me?.voice.channelId ?? null).pipe(
        Effect.repeat({ until: (channelId) => channelId === null, schedule: Schedule.spaced("100 millis") }),
        Effect.timeoutOption(LEAVE_TIMEOUT),
      ),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.logWarning("Discord didn't confirm the bot left the office before recording"),
        onSome: () => Effect.void,
      }),
    ),
    Effect.catchTag("BotMoveError", (error) =>
      Effect.logWarning("Couldn't step out of the office before recording").pipe(
        Effect.annotateLogs({ reason: error.reason }),
      ),
    ),
  );

const setNickname = (guild: Guild, nickname: string | null) =>
  Effect.tryPromise(() => guild.members.me?.setNickname(nickname) ?? Promise.resolve(null)).pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning("Couldn't change the bot's nickname. Give it the Change Nickname permission.").pipe(
        Effect.annotateLogs({ reason: String(error) }),
      ),
    ),
  );

const occupantOf = (member: GuildMember): Occupant => ({
  userId: member.id,
  displayName: member.displayName,
  avatarUrl: member.displayAvatarURL({ extension: "png", size: 128 }),
});

const login = (client: Client, token: Redacted.Redacted<string>) =>
  Effect.callback<Client<true>, DiscordLoginError>((resume) => {
    client.once(Events.ClientReady, (ready) => resume(Effect.succeed(ready)));
    client.login(Redacted.value(token)).catch((cause: unknown) => {
      resume(Effect.fail(new DiscordLoginError({ cause })));
    });
  });

export interface TestGateway {
  readonly updates: Queue.Dequeue<VoiceStateUpdate, Cause.Done>;
  readonly occupants?: Occupants;
  readonly guildId?: string;
  readonly present?: ReadonlyArray<VoiceStateUpdate>;
  readonly effects?: ReadonlyArray<VoiceEffect>;
  readonly moves?: Queue.Enqueue<BotPresence>;
  readonly recordings?: Queue.Enqueue<boolean>;
  readonly selfId?: string;
}

export class DiscordGateway extends Context.Service<
  DiscordGateway,
  {
    readonly officeEvents: Stream.Stream<OfficeEvent>;
    // Everything to record about the office, from the same updates.
    readonly voiceObservations: Stream.Stream<VoiceObservation>;
    readonly voiceEffects: Stream.Stream<TimedVoiceEffect>;
    readonly botPresence: Stream.Stream<BotPresence>;
    moveBot(presence: BotPresence): Effect.Effect<void>;
    // Un-deafens and renames the bot while it records, and back afterwards.
    setRecording(active: boolean): Effect.Effect<void>;
    readonly occupants: Effect.Effect<ReadonlyArray<Occupant>>;
    readonly selfUserId: string;
    readonly voiceAdapter: Option.Option<DiscordGatewayAdapterCreator>;
    // None when the office channel wasn't found at startup.
    readonly office: Option.Option<OfficeLocation>;
  }
>()("virtual-office-notifier/DiscordGateway") {
  static readonly layer = Layer.effect(
    DiscordGateway,
    Effect.gen(function* () {
      const { botToken, officeChannelId } = yield* DiscordConfig;
      const context = yield* Effect.context();
      const runFork = Effect.runForkWith(context);

      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Client({
              intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildExpressions],
            }),
        ),
        (client) =>
          Effect.promise(() => client.destroy()).pipe(Effect.andThen(Effect.logInfo("Disconnected from Discord"))),
      );

      // An EventEmitter "error" event with no listener would crash the process.
      client.on(Events.Error, (error) =>
        runFork(Effect.logError("Discord client error", error).pipe(Effect.andThen(ErrorReporter.report(Cause.fail(error))))),
      );
      client.on(Events.Warn, (message) => runFork(Effect.logWarning("Discord client warning", message)));

      const ready = yield* login(client, botToken);

      const office = Option.fromUndefinedOr(ready.channels.cache.get(officeChannelId)).pipe(
        Option.filter((channel) => channel.isVoiceBased()),
      );

      yield* Effect.logInfo("Connected to Discord").pipe(
        Effect.annotateLogs({ user: ready.user.tag, guilds: ready.guilds.cache.size }),
      );

      const defaultSounds = yield* fetchDefaultSoundNames(ready);
      const updates = () => voiceStateUpdates(client).pipe(fromOthers(ready.user.id));

      // From the voice states Discord sends on connect.
      const present = Option.match(office, {
        onNone: () => [],
        onSome: (channel) => [...channel.members.filter((member) => !member.user.bot).values()],
      });

      // Seeded from who's present, so restarting while people are in the office
      // doesn't announce it opening again.
      const occupants: Occupants = new Set(present.map((member) => member.id));

      // Keep running either way: the bot may be added to the server later.
      yield* Option.match(office, {
        onNone: () =>
          Effect.logWarning(
            "Office voice channel not found. Check DISCORD_OFFICE_CHANNEL_ID and that the bot is in the server and can view the channel.",
          ).pipe(Effect.annotateLogs({ officeChannelId, guilds: ready.guilds.cache.size })),
        onSome: (channel) =>
          Effect.logInfo("Found the office voice channel").pipe(
            Effect.annotateLogs({ officeChannelId, officeChannel: channel.name, occupants: occupants.size }),
            Effect.andThen(
              channel.permissionsFor(ready.user)?.has(PermissionFlagsBits.Connect)
                ? Effect.void
                : Effect.logWarning(
                    "The bot can't connect to the office voice channel, so soundboard sounds and emoji reactions aren't recorded. Give it the Connect permission.",
                  ),
            ),
          ),
      });

      const wanted = yield* Ref.make<BotPresence>("Away");
      const recording = yield* Ref.make(false);

      const goWhereWanted = Option.match(office, {
        onNone: () => Effect.void,
        onSome: (channel) =>
          Effect.all([Ref.get(wanted), Ref.get(recording)]).pipe(
            Effect.flatMap(([presence, active]) => (active ? Effect.void : moveBot(channel.guild, officeChannelId)(presence))),
          ),
      });

      const setRecording = (active: boolean) =>
        Option.match(office, {
          onNone: () => Ref.set(recording, active),
          onSome: (channel) =>
            Ref.set(recording, active).pipe(
              Effect.andThen(setNickname(channel.guild, active ? RECORDING_NICKNAME : null)),
              Effect.andThen(active ? leaveForRecording(channel.guild) : goWhereWanted),
            ),
        });

      const whoIsIn = Effect.sync(
        (): ReadonlyArray<Occupant> =>
          Option.match(office, {
            onNone: () => [],
            onSome: (channel) => [...channel.members.filter((member) => !member.user.bot).values()].map(occupantOf),
          }),
      );

      client.on(Events.ShardReady, () => runFork(goWhereWanted));
      client.on(Events.ShardResume, () => runFork(goWhereWanted));

      return DiscordGateway.of({
        officeEvents: updates().pipe(officeEvents(officeChannelId, occupants)),
        voiceObservations: updates().pipe(
          voiceObservations(officeChannelId, present.map(alreadyPresent)),
        ),
        voiceEffects: voiceEffects(client, defaultSounds).pipe(fromOthers(ready.user.id), officeEffects(officeChannelId)),
        botPresence: Option.match(office, {
          onNone: () => Stream.empty,
          onSome: () => botPresence(occupants, updates().pipe(officeEvents(officeChannelId, occupants))),
        }),
        moveBot: (presence) => Ref.set(wanted, presence).pipe(Effect.andThen(goWhereWanted)),
        setRecording,
        occupants: whoIsIn,
        selfUserId: ready.user.id,
        voiceAdapter: Option.map(office, (channel) => channel.guild.voiceAdapterCreator),
        office: Option.map(office, (channel) => ({ guildId: channel.guild.id, channelId: officeChannelId })),
      });
    }),
  );

  // Feeds the same occupancy tracking and observations from a queue, so tests
  // exercise everything but discord.js itself. `present` is who was in the
  // office at startup.
  static readonly layerTest = ({
    updates,
    occupants = new Set(),
    guildId = "guild",
    present = [],
    effects = [],
    moves,
    recordings,
    selfId = "self",
  }: TestGateway) =>
    Layer.effect(
      DiscordGateway,
      Effect.gen(function* () {
        const { officeChannelId } = yield* DiscordConfig;

        // Every stream needs every update, like the listeners on the real
        // client.
        const shared = yield* Stream.fromQueue(updates).pipe(
          fromOthers(selfId),
          Stream.broadcast({ capacity: "unbounded", replay: 1000 }),
        );

        const inOffice = yield* Ref.make<ReadonlyMap<string, Occupant>>(
          new Map(present.map((update) => [update.userId, occupantOfUpdate(update)])),
        );

        yield* shared.pipe(
          Stream.runForEach((update) =>
            Ref.update(inOffice, (members) => {
              const next = new Map(members);

              if (isOfficeJoin(officeChannelId, update)) next.set(update.userId, occupantOfUpdate(update));

              if (isOfficeLeave(officeChannelId, update)) next.delete(update.userId);

              return next;
            }),
          ),
          Effect.forkScoped,
        );

        return DiscordGateway.of({
          officeEvents: shared.pipe(officeEvents(officeChannelId, occupants)),
          voiceObservations: shared.pipe(voiceObservations(officeChannelId, present)),
          voiceEffects: Stream.fromIterable(effects).pipe(fromOthers(selfId), officeEffects(officeChannelId)),
          botPresence: botPresence(occupants, shared.pipe(officeEvents(officeChannelId, occupants))),
          moveBot: (presence) => (moves === undefined ? Effect.void : Queue.offer(moves, presence).pipe(Effect.asVoid)),
          setRecording: (active) =>
            recordings === undefined ? Effect.void : Queue.offer(recordings, active).pipe(Effect.asVoid),
          occupants: Ref.get(inOffice).pipe(Effect.map((members) => [...members.values()])),
          selfUserId: selfId,
          voiceAdapter: Option.none(),
          office: Option.some({ guildId, channelId: officeChannelId }),
        });
      }),
    );
}
