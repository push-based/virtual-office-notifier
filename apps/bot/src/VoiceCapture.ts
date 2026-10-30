import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Buffer } from "node:buffer";

import {
  Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";

import { addPacket, type Clip, type Cut, flush, startClip } from "./ClipCutter.ts";
import { DiscordGateway } from "./DiscordGateway.ts";
import type { OfficeLocation } from "./OfficeEvent.ts";
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
}) {}

export const SILENCE_ENDS_CLIP = Duration.millis(1500);

const CONNECT_TIMEOUT = 20_000;

const RECONNECT_TIMEOUT = Duration.seconds(5);

const destroy = (connection: VoiceConnection) =>
  Effect.sync(() => {
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  });

export class VoiceCapture extends Context.Service<
  VoiceCapture,
  {
    capture(office: OfficeLocation): Stream.Stream<Heard, CaptureError>;
  }
>()("bot/VoiceCapture") {
  static readonly layer = Layer.effect(
    VoiceCapture,
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway;

      const capture = (office: OfficeLocation) =>
        Stream.callback<Heard, CaptureError>(
          Effect.fnUntraced(function* (queue) {
            const adapterCreator = yield* Effect.fromOption(gateway.voiceAdapter, () =>
              CaptureError.make({ reason: "The office voice channel wasn't found" }),
            );

            const connection = yield* Effect.acquireRelease(
              Effect.sync(() =>
                joinVoiceChannel({
                  channelId: office.channelId,
                  guildId: office.guildId,
                  adapterCreator,
                  selfDeaf: false,
                  selfMute: true,
                }),
              ),
              destroy,
            );

            const clock = yield* Clock.Clock;
            const now = () => DateTime.makeUnsafe(clock.currentTimeMillisUnsafe());

            const reconnects = yield* FiberSet.make();
            const runFork = yield* FiberSet.runtime(reconnects)();

            const fail = (reason: string) => {
              Queue.failCauseUnsafe(queue, Cause.fail(CaptureError.make({ reason })));
            };

            const reaches = (status: VoiceConnectionStatus) =>
              Effect.tryPromise((signal) => entersState(connection, status, signal));

            const reconnect = Effect.raceFirst(
              reaches(VoiceConnectionStatus.Signalling),
              reaches(VoiceConnectionStatus.Connecting),
            ).pipe(
              Effect.timeout(RECONNECT_TIMEOUT),
              Effect.catch(() => Effect.sync(() => fail("Disconnected from the voice channel"))),
            );

            connection.on("error", (error) => fail(`Voice connection error: ${error.message}`));

            connection.on(VoiceConnectionStatus.Disconnected, () => runFork(reconnect));

            yield* Effect.tryPromise({
              try: () => entersState(connection, VoiceConnectionStatus.Ready, CONNECT_TIMEOUT),
              catch: (cause) =>
                CaptureError.make({
                  reason: `Couldn't connect to the voice channel: ${String(cause)}`,
                }),
            });

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

              stream.on("end", flushPartial);
              stream.on("error", flushPartial);
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
              }),
            );
          }),
        );

      return VoiceCapture.of({ capture });
    }),
  );

  static readonly layerTest = (heard: Queue.Dequeue<Heard, Cause.Done | CaptureError>) =>
    Layer.succeed(VoiceCapture, VoiceCapture.of({ capture: () => Stream.fromQueue(heard) }));
}
