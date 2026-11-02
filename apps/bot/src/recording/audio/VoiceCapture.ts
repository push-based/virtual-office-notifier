import {
  type AudioReceiveStream,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Buffer } from "node:buffer";

import {
  Array,
  Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  FiberSet,
  Layer,
  type LogLevel,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";

import { addPacket, type Clip, type Cut, flush, startClip } from "./ClipCutter.ts";
import { connectionStep, DiscordGateway } from "../../office/index.ts";
import { OPUS_SAMPLE_RATE, opusPacketSamples } from "./OggOpus.ts";

export type Heard = Data.TaggedEnum<{
  Spoke: { readonly clip: Clip };
  StartedSpeaking: { readonly userId: string };
  StoppedSpeaking: { readonly userId: string };
}>;

export const Heard = Data.taggedEnum<Heard>();

export class CaptureError extends Schema.TaggedError<
  CaptureError,
  { readonly brand: unique symbol }
>()("CaptureError", {
  reason: Schema.String,
  history: Schema.Array(Schema.String).pipe(Schema.withConstructorDefault(Effect.succeed([]))),
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

export const SILENCE_ENDS_CLIP = Duration.millis(1500);

const CONNECT_TIMEOUT = 20_000;

const RECONNECT_TIMEOUT = Duration.seconds(5);

export class VoiceCapture extends Context.Service<
  VoiceCapture,
  {
    capture(until: Effect.Effect<void>): Stream.Stream<Heard, CaptureError>;
  }
>()("bot/recording/audio/VoiceCapture") {
  static readonly layer = Layer.effect(
    VoiceCapture,
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway;

      const capture = (until: Effect.Effect<void>) =>
        Stream.callback<Heard, CaptureError>(
          Effect.fnUntraced(function* (queue) {
            const officeVoice = yield* Effect.fromOption(gateway.voice, () =>
              CaptureError.make({ reason: "The office voice channel wasn't found" }),
            );

            const { connection, history } = yield* officeVoice.current.pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.mapError(() =>
                CaptureError.make({ reason: "The bot isn't in the office voice channel" }),
              ),
            );

            const clock = yield* Clock.Clock;
            const now = () => DateTime.makeUnsafe(clock.currentTimeMillisUnsafe());

            const failure = (reason: string) =>
              CaptureError.make({ reason, history: history.entries() });

            const fail = (reason: string) => {
              Queue.failCauseUnsafe(queue, Cause.fail(failure(reason)));
            };

            const flushes = new Set<() => void>();
            const streams = new Set<AudioReceiveStream>();

            const stop = Effect.sync(() => {
              for (const flushPartial of flushes) flushPartial();
            }).pipe(Effect.andThen(Queue.end(queue)));

            yield* until.pipe(Effect.andThen(stop), Effect.forkScoped);

            const reconnects = yield* FiberSet.make();
            const runFork = yield* FiberSet.runtime(reconnects)();

            const reaches = (status: VoiceConnectionStatus) =>
              Effect.tryPromise((signal) => entersState(connection, status, signal));

            const reconnect = Effect.raceFirst(
              reaches(VoiceConnectionStatus.Signalling),
              reaches(VoiceConnectionStatus.Connecting),
            ).pipe(
              Effect.timeout(RECONNECT_TIMEOUT),
              Effect.catch(() =>
                Effect.sync(() =>
                  fail(`Lost the voice channel, stuck at ${connectionStep(connection.state)}`),
                ),
              ),
            );

            const onError = (error: Error) => fail(`Voice connection error: ${error.message}`);
            const onDisconnected = () => runFork(reconnect);
            const onDestroyed = () => fail("The office voice connection closed");

            connection.on("error", onError);
            connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);
            connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                connection.off("error", onError);
                connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
                connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
              }),
            );

            yield* Effect.tryPromise({
              try: () => entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT),
              catch: (cause) =>
                failure(
                  `Couldn't connect to the voice channel, stuck at ${connectionStep(connection.state)}: ${String(cause)}`,
                ),
            }).pipe(
              Effect.ensuring(
                Effect.suspend(() =>
                  Effect.annotateCurrentSpan({
                    "voice.step": connectionStep(connection.state),
                    "voice.history": Array.join(history.entries(), "\n"),
                  }),
                ),
              ),
              Effect.withSpan("VoiceCapture.connect"),
            );

            const receiver = connection.receiver;

            const onSpeakingStart = (userId: string) => {
              if (userId === gateway.selfUserId) return;

              Queue.offerUnsafe(queue, Heard.StartedSpeaking({ userId }));

              if (receiver.subscriptions.has(userId)) return;

              const stream = receiver.subscribe(userId, {
                end: {
                  behavior: EndBehaviorType.AfterSilence,
                  duration: Duration.toMillis(SILENCE_ENDS_CLIP),
                },
              });

              let partial = startClip(userId, now());

              const take = (cut: Cut) => {
                partial = cut.partial;

                if (Option.isSome(cut.finished))
                  Queue.offerUnsafe(queue, Heard.Spoke({ clip: cut.finished.value }));
              };

              const flushPartial = () => take(flush(partial));

              const close = () => {
                streams.delete(stream);
                flushes.delete(flushPartial);
                flushPartial();
              };

              streams.add(stream);
              flushes.add(flushPartial);

              stream.on("data", (packet: Buffer) =>
                take(
                  addPacket(
                    partial,
                    new Uint8Array(packet),
                    Duration.millis((opusPacketSamples(packet) * 1000) / OPUS_SAMPLE_RATE),
                    now(),
                  ),
                ),
              );

              stream.on("end", close);
              stream.on("error", close);
            };

            const onSpeakingEnd = (userId: string) => {
              if (userId !== gateway.selfUserId)
                Queue.offerUnsafe(queue, Heard.StoppedSpeaking({ userId }));
            };

            receiver.speaking.on("start", onSpeakingStart);
            receiver.speaking.on("end", onSpeakingEnd);

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                receiver.speaking.off("start", onSpeakingStart);
                receiver.speaking.off("end", onSpeakingEnd);

                for (const stream of streams) stream.destroy();
              }),
            );
          }),
        );

      return VoiceCapture.of({ capture });
    }),
  );

  static readonly layerTest = (heard: Queue.Dequeue<Heard, Cause.Done | CaptureError>) =>
    Layer.succeed(
      VoiceCapture,
      VoiceCapture.of({
        capture: (until) => Stream.fromQueue(heard).pipe(Stream.interruptWhen(until)),
      }),
    );
}
