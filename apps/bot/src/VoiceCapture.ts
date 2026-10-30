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
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Queue,
  Schema,
  Stream,
} from "effect";

import { DiscordGateway } from "./DiscordGateway.ts";
import type { OfficeLocation } from "./OfficeEvent.ts";
import { OPUS_SAMPLE_RATE, opusPacketSamples } from "./OggOpus.ts";

export interface Clip {
  readonly userId: string;
  readonly startedAt: DateTime.Utc;
  readonly packets: ReadonlyArray<Uint8Array>;
}

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

export const MAX_CLIP = Duration.minutes(5);

const CONNECT_TIMEOUT = 20_000;

const RECONNECT_TIMEOUT = 5_000;

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
      const maxClipMs = Duration.toMillis(MAX_CLIP);

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

            const fail = (reason: string) => {
              Queue.failCauseUnsafe(queue, Cause.fail(CaptureError.make({ reason })));
            };

            connection.on("error", (error) => fail(`Voice connection error: ${error.message}`));

            connection.on(VoiceConnectionStatus.Disconnected, () => {
              Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_TIMEOUT),
                entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_TIMEOUT),
              ]).catch(() => fail("Disconnected from the voice channel"));
            });

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

              let startedAt = DateTime.nowUnsafe();
              let packets: Array<Uint8Array> = [];
              let durationMs = 0;

              const emit = () => {
                if (packets.length > 0)
                  Queue.offerUnsafe(queue, Heard.Spoke({ clip: { userId, startedAt, packets } }));

                packets = [];
                durationMs = 0;
              };

              stream.on("data", (packet: Buffer) => {
                packets.push(new Uint8Array(packet));
                durationMs += (opusPacketSamples(packet) * 1000) / OPUS_SAMPLE_RATE;

                if (durationMs >= maxClipMs) {
                  emit();
                  startedAt = DateTime.nowUnsafe();
                }
              });

              stream.on("end", emit);
              stream.on("error", emit);
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
