import {
  type DiscordGatewayAdapterLibraryMethods,
  NetworkingStatusCode,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, ErrorReporter } from "effect";
import { createRequire } from "node:module";

import { CaptureError, connectionStep } from "../../../src/recording/audio/VoiceCapture.ts";
import { captureReports } from "../../fakes.ts";

const OFFICE = { guildId: "guild", channelId: "office" };

// Vite's transform loses discord-api-types' re-exported enums, so the test
// loads the library's CommonJS build through Node instead.
const voice: typeof import("@discordjs/voice") = createRequire(import.meta.url)("@discordjs/voice");

const joinWithFakeGateway = () => {
  const gateway: Array<DiscordGatewayAdapterLibraryMethods> = [];

  const connection = voice.joinVoiceChannel({
    ...OFFICE,
    group: "VoiceCapture.test",
    adapterCreator: (methods) => {
      gateway.push(methods);

      return { sendPayload: () => true, destroy: () => undefined };
    },
  });

  connection.on("error", () => undefined);

  return { connection, gateway: gateway[0] };
};

describe("VoiceCapture", () => {
  it("names the step a connection is stuck at", () => {
    assert.strictEqual(connectionStep({ status: VoiceConnectionStatus.Signalling }), "signalling");
    assert.strictEqual(
      connectionStep({
        status: VoiceConnectionStatus.Connecting,
        networking: { state: { code: NetworkingStatusCode.UdpHandshaking } },
      }),
      "connecting (UDP handshake)",
    );
    assert.strictEqual(
      connectionStep({
        status: VoiceConnectionStatus.Connecting,
        networking: { state: { code: NetworkingStatusCode.Identifying } },
      }),
      "connecting (identifying)",
    );
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

  // Discord can send the voice server before the voice state. Released
  // @discordjs/voice ignores the state when it comes second, so the join waits
  // in signalling until it times out. patches/@discordjs__voice@0.19.2.patch
  // backports discordjs/discord.js#11581, which connects once both are in.
  it("connects when Discord sends the voice server before the voice state", () => {
    const { connection, gateway } = joinWithFakeGateway();

    try {
      gateway?.onVoiceServerUpdate({
        guild_id: OFFICE.guildId,
        token: "token",
        endpoint: "127.0.0.1:1",
      });

      assert.strictEqual(connection.state.status, VoiceConnectionStatus.Signalling);

      gateway?.onVoiceStateUpdate({
        guild_id: OFFICE.guildId,
        channel_id: OFFICE.channelId,
        user_id: "bot",
        session_id: "session",
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: true,
        self_video: false,
        suppress: false,
        request_to_speak_timestamp: null,
      });

      assert.strictEqual(connection.state.status, VoiceConnectionStatus.Connecting);
    } finally {
      connection.destroy();
    }
  });
});
