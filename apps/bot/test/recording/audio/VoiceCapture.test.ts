import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { assert, describe, it } from "@effect/vitest";
import {
  Array,
  Cause,
  type Cause as CauseType,
  Effect,
  ErrorReporter,
  Fiber,
  Layer,
  Option,
  Queue,
  Stream,
} from "effect";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";

import { DiscordGateway } from "../../../src/office/DiscordGateway.ts";
import { startJoinHistory } from "../../../src/office/JoinHistory.ts";
import type { VoiceStateUpdate } from "../../../src/office/OfficeEvent.ts";
import { CaptureError, VoiceCapture } from "../../../src/recording/audio/VoiceCapture.ts";
import { captureReports, pollUntil, withEnv } from "../../fakes.ts";

const voice: typeof import("@discordjs/voice") = createRequire(import.meta.url)("@discordjs/voice");

const silentDiscord: DiscordGatewayAdapterCreator = () => ({
  sendPayload: () => true,
  destroy: () => undefined,
});

const celt20ms = Buffer.from([0b1111_1100, 1, 2, 3]);

const readyConnection = () => {
  const connection = voice.joinVoiceChannel({
    guildId: "capture",
    channelId: "office",
    adapterCreator: silentDiscord,
  });

  Reflect.set(connection, "state", { ...connection.state, status: VoiceConnectionStatus.Ready });

  return connection;
};

describe("VoiceCapture", () => {
  it("sends how the join went along with the reason", () => {
    const error = CaptureError.make({
      reason: "Couldn't connect, stuck at signalling",
      history: ["+0ms asked Discord to join the office", "+20000ms signalling"],
    });

    assert.deepStrictEqual(error[ErrorReporter.attributes], {
      reason: "Couldn't connect, stuck at signalling",
      history: "+0ms asked Discord to join the office\n+20000ms signalling",
    });
  });

  it.effect("reports a lost voice connection as a warning with its reason", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      yield* ErrorReporter.report(
        Cause.fail(CaptureError.make({ reason: "Couldn't connect, stuck at signalling" })),
      );

      assert.deepStrictEqual(reports, [
        {
          name: "CaptureError",
          message: "Couldn't connect, stuck at signalling",
          severity: "Warn",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands on what someone was saying when the voice connection fails", () =>
    Effect.gen(function* () {
      const connection = readyConnection();
      const updates = yield* Queue.unbounded<VoiceStateUpdate, CauseType.Done>();

      const gateway = Layer.effect(
        DiscordGateway,
        Effect.map(DiscordGateway, (fake) =>
          DiscordGateway.of({
            ...fake,
            voice: Option.some({
              join: () => Effect.void,
              leave: Effect.void,
              current: Effect.succeedSome({ connection, history: startJoinHistory(() => 0) }),
            }),
          }),
        ),
      ).pipe(Layer.provide(DiscordGateway.layerTest({ updates })));

      const heard = yield* Effect.gen(function* () {
        const capture = yield* VoiceCapture;

        const running = yield* capture.capture(Effect.never).pipe(
          Stream.catch(() => Stream.empty),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* pollUntil(
          Effect.sync(() => connection.receiver.speaking.listenerCount("start")),
          (listeners) => listeners > 0,
        );
        connection.receiver.speaking.emit("start", "u1");
        connection.receiver.subscriptions.get("u1")?.push(celt20ms);
        yield* Effect.yieldNow;
        connection.emit("error", new Error("socket closed"));

        return yield* Fiber.join(running);
      }).pipe(
        Effect.provide(VoiceCapture.layer.pipe(Layer.provide(gateway))),
        withEnv({ DISCORD_BOT_TOKEN: "token", DISCORD_OFFICE_CHANNEL_ID: "office" }),
        Effect.ensuring(Effect.sync(() => connection.destroy())),
      );

      assert.deepStrictEqual(
        Array.map(heard, (item) => item._tag),
        ["StartedSpeaking", "Spoke"],
      );
    }),
  );
});
