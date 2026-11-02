import {
  type DiscordGatewayAdapterCreator,
  entersState,
  type joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  Array,
  Cause,
  Clock,
  Duration,
  Effect,
  ErrorReporter,
  type LogLevel,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect";

import {
  connectionStep,
  describeVoiceServer,
  describeVoiceState,
  type JoinHistory,
  startJoinHistory,
} from "./JoinHistory.ts";

export const CONNECT_TIMEOUT = Duration.seconds(20);

export const RECONNECT_TIMEOUT = Duration.seconds(5);

export const REJOIN_DELAY = Duration.seconds(5);

export const LEAVE_TIMEOUT = Duration.seconds(5);

export class VoiceJoinError extends Schema.TaggedError<
  VoiceJoinError,
  { readonly brand: unique symbol }
>()("VoiceJoinError", {
  reason: Schema.String,
  history: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return this.reason;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason, history: Array.join(this.history, "\n") };
  }
}

export interface LiveVoice {
  readonly connection: VoiceConnection;
  readonly history: JoinHistory;
}

export interface OfficeVoice {
  join(listening: boolean): Effect.Effect<void>;
  readonly leave: Effect.Effect<void>;
  readonly current: Effect.Effect<Option.Option<LiveVoice>>;
}

export interface VoicePort {
  readonly guildId: string;
  readonly channelId: string;
  readonly adapterCreator: DiscordGatewayAdapterCreator;
  readonly joinVoiceChannel: typeof joinVoiceChannel;
  readonly inVoice: Effect.Effect<boolean>;
  readonly stepOut: Effect.Effect<void>;
}

export const recordingGateway =
  (
    adapterCreator: DiscordGatewayAdapterCreator,
    history: JoinHistory,
  ): DiscordGatewayAdapterCreator =>
  (methods) =>
    adapterCreator({
      ...methods,
      onVoiceServerUpdate: (data) => {
        history.record(describeVoiceServer(data));
        methods.onVoiceServerUpdate(data);
      },
      onVoiceStateUpdate: (data) => {
        history.record(describeVoiceState(data));
        methods.onVoiceStateUpdate(data);
      },
    });

const isLive = (connection: VoiceConnection) =>
  connection.state.status !== VoiceConnectionStatus.Destroyed;

const destroy = (connection: VoiceConnection) =>
  Effect.sync(() => {
    if (isLive(connection)) connection.destroy();
  });

const reaches = (connection: VoiceConnection, status: VoiceConnectionStatus) =>
  Effect.tryPromise((signal) => entersState(connection, status, signal)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const recovers = (connection: VoiceConnection) =>
  Effect.raceFirst(
    reaches(connection, VoiceConnectionStatus.Signalling),
    reaches(connection, VoiceConnectionStatus.Connecting),
  ).pipe(Effect.timeoutOption(RECONNECT_TIMEOUT), Effect.map(Option.getOrElse(() => false)));

export const officeVoiceIn = Effect.fnUntraced(function* (port: VoicePort) {
  const scope = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const wanted = yield* Ref.make(Option.none<boolean>());
  const live = yield* Ref.make(Option.none<LiveVoice>());
  const stalled = yield* Ref.make(0);
  const changing = yield* Semaphore.make(1);
  const oneChangeAtATime = changing.withPermits(1);

  const stepOutOfStaleSeat = Effect.gen(function* () {
    if (!(yield* port.inVoice)) return;

    yield* port.stepOut;
    yield* port.inVoice.pipe(
      Effect.repeat({ until: (inVoice) => !inVoice, schedule: Schedule.spaced("100 millis") }),
      Effect.timeoutOption(LEAVE_TIMEOUT),
    );
  });

  const configFor = (listening: boolean) => ({
    channelId: port.channelId,
    selfDeaf: !listening,
    selfMute: true,
  });

  const open = (listening: boolean): Effect.Effect<LiveVoice> =>
    Effect.gen(function* () {
      yield* stepOutOfStaleSeat;

      const history = startJoinHistory(() => clock.currentTimeMillisUnsafe());

      history.record(listening ? "asked Discord to join, listening" : "asked Discord to join");

      const connection = port.joinVoiceChannel({
        ...configFor(listening),
        guildId: port.guildId,
        adapterCreator: recordingGateway(port.adapterCreator, history),
      });

      const watched = new WeakSet<object>();

      connection.on("error", (error) => history.record(`error: ${error.message}`));
      connection.on("stateChange", (_, next) => {
        history.step(next);

        if ("networking" in next && !watched.has(next.networking)) {
          watched.add(next.networking);
          next.networking.on("close", (code) =>
            history.record(`voice WebSocket closed with ${code}`),
          );
        }
      });

      const opened: LiveVoice = { connection, history };

      yield* Ref.set(live, Option.some(opened));
      yield* Effect.forkIn(keep(opened), scope);

      return opened;
    });

  const reopenIfStillWanted = (replaced: LiveVoice) =>
    oneChangeAtATime(
      Effect.gen(function* () {
        const current = yield* Ref.get(live);
        const listening = yield* Ref.get(wanted);

        if (Option.isSome(current) && current.value !== replaced) return;

        if (Option.isNone(listening)) return;

        yield* open(listening.value);
      }),
    );

  const replace = (stale: LiveVoice, reason: string) =>
    Effect.gen(function* () {
      yield* destroy(stale.connection);
      yield* Effect.logWarning("Lost the office voice connection, joining again").pipe(
        Effect.annotateLogs({ reason }),
      );
      yield* Effect.sleep(REJOIN_DELAY);
      yield* reopenIfStillWanted(stale);
    });

  const waitUntilReady = (voice: LiveVoice) =>
    reaches(voice.connection, VoiceConnectionStatus.Ready).pipe(
      Effect.timeoutOption(CONNECT_TIMEOUT),
      Effect.map(Option.getOrElse(() => false)),
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          "voice.step": connectionStep(voice.connection.state),
          "voice.history": Array.join(voice.history.entries(), "\n"),
        }),
      ),
      Effect.withSpan("OfficeVoice.join"),
    );

  const reportStall = (voice: LiveVoice) =>
    Effect.gen(function* () {
      const error = VoiceJoinError.make({
        reason: `Couldn't join the office voice channel, stuck at ${connectionStep(voice.connection.state)}`,
        history: voice.history.entries(),
      });

      if ((yield* Ref.getAndUpdate(stalled, (count) => count + 1)) === 0)
        yield* ErrorReporter.report(Cause.fail(error));

      return error.reason;
    });

  function keep(voice: LiveVoice): Effect.Effect<void> {
    return Effect.gen(function* () {
      while (isLive(voice.connection)) {
        if (!(yield* waitUntilReady(voice))) {
          if (!isLive(voice.connection)) return;

          return yield* replace(voice, yield* reportStall(voice));
        }

        yield* Ref.set(stalled, 0);
        yield* Effect.raceFirst(
          reaches(voice.connection, VoiceConnectionStatus.Disconnected),
          reaches(voice.connection, VoiceConnectionStatus.Destroyed),
        );

        if (!isLive(voice.connection)) return;

        if (!(yield* recovers(voice.connection)))
          return yield* replace(voice, connectionStep(voice.connection.state));
      }
    });
  }

  const join = (listening: boolean) =>
    oneChangeAtATime(
      Effect.gen(function* () {
        yield* Ref.set(wanted, Option.some(listening));

        const current = Option.filter(yield* Ref.get(live), ({ connection }) => isLive(connection));

        if (Option.isNone(current)) {
          yield* open(listening);

          return;
        }

        current.value.history.record(listening ? "asked to listen" : "asked to stop listening");
        current.value.connection.rejoin(configFor(listening));
      }),
    );

  const leave = oneChangeAtATime(
    Effect.gen(function* () {
      yield* Ref.set(wanted, Option.none());

      const current = yield* Ref.getAndSet(live, Option.none());

      if (Option.isSome(current)) yield* destroy(current.value.connection);
    }),
  );

  yield* Effect.addFinalizer(() => leave);

  const office: OfficeVoice = {
    join,
    leave,
    current: Effect.map(
      Ref.get(live),
      Option.filter(({ connection }) => isLive(connection)),
    ),
  };

  return office;
});
