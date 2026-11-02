import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { createRequire } from "node:module";

import { startJoinHistory } from "../../src/office/JoinHistory.ts";
import {
  CONNECT_TIMEOUT,
  officeVoiceIn,
  recordingGateway,
  REJOIN_DELAY,
} from "../../src/office/OfficeVoice.ts";
import { captureReports, pollUntil } from "../fakes.ts";

const OFFICE = "office";

// Vite's transform loses discord-api-types' re-exported enums, so the tests
// load the library's CommonJS build through Node instead.
const voice: typeof import("@discordjs/voice") = createRequire(import.meta.url)("@discordjs/voice");

interface VoiceStatePayload {
  readonly d: { readonly channel_id: string | null; readonly self_deaf: boolean };
}

const voiceState = (channelId: string | null) => ({
  guild_id: "guild",
  channel_id: channelId,
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

const fakeDiscord = () => {
  const sent: Array<string> = [];
  const gateways: Array<DiscordGatewayAdapterLibraryMethods> = [];

  const adapterCreator: DiscordGatewayAdapterCreator = (methods) => {
    gateways.push(methods);

    return {
      sendPayload: ({ d }: VoiceStatePayload) => {
        sent.push(
          d.channel_id === null ? "leave" : d.self_deaf ? "join deafened" : "join listening",
        );

        return true;
      },
      destroy: () => undefined,
    };
  };

  return { sent, gateways, adapterCreator };
};

const setUp = Effect.fnUntraced(function* (guildId: string, options: { stale?: boolean } = {}) {
  const discord = fakeDiscord();
  const seated = yield* Ref.make(options.stale === true);
  const steps: Array<string> = [];

  const office = yield* officeVoiceIn({
    guildId,
    channelId: OFFICE,
    adapterCreator: (methods) => {
      steps.push("joined");

      return discord.adapterCreator(methods);
    },
    joinVoiceChannel: voice.joinVoiceChannel,
    inVoice: Ref.get(seated),
    stepOut: Effect.sync(() => steps.push("stepped out")).pipe(
      Effect.andThen(Ref.set(seated, false)),
    ),
  });

  return { office, steps, ...discord };
});

describe("OfficeVoice", () => {
  it.effect("stays on one connection: joins deafened, listens, deafens again, then leaves", () =>
    Effect.gen(function* () {
      const { office, sent, gateways } = yield* setUp("one-connection");

      yield* office.join(false);
      yield* office.join(true);
      yield* office.join(false);

      assert.isTrue(Option.isSome(yield* office.current));

      yield* office.leave;

      assert.deepStrictEqual(sent, ["join deafened", "join listening", "join deafened", "leave"]);
      assert.strictEqual(gateways.length, 1);
      assert.isTrue(Option.isNone(yield* office.current));
    }).pipe(Effect.scoped),
  );

  it.effect("steps out of a seat left over from before it joins", () =>
    Effect.gen(function* () {
      const { office, steps } = yield* setUp("stale-seat", { stale: true });

      yield* office.join(false);

      assert.deepStrictEqual(steps, ["stepped out", "joined"]);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces a join that never connects, and reports it once per outage", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      const { office, sent, gateways } = yield* setUp("stalled");

      yield* office.join(false);
      yield* TestClock.adjust(CONNECT_TIMEOUT);
      yield* pollUntil(
        Effect.sync(() => sent.length),
        (count) => count > 1,
      );
      yield* TestClock.adjust(REJOIN_DELAY);
      yield* pollUntil(
        Effect.sync(() => gateways.length),
        (count) => count > 1,
      );
      yield* TestClock.adjust(CONNECT_TIMEOUT);
      yield* TestClock.adjust(REJOIN_DELAY);
      yield* pollUntil(
        Effect.sync(() => gateways.length),
        (count) => count > 2,
      );

      assert.deepStrictEqual(sent.slice(0, 5), [
        "join deafened",
        "leave",
        "join deafened",
        "leave",
        "join deafened",
      ]);
      assert.deepStrictEqual(reports, [
        {
          name: "VoiceJoinError",
          message: "Couldn't join the office voice channel, stuck at signalling",
          severity: "Warn",
        },
      ]);

      yield* office.leave;
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it("notes what Discord sends the voice connection and still passes it on", () => {
    const history = startJoinHistory(() => 0);
    const received: Array<string> = [];
    const { gateways, adapterCreator } = fakeDiscord();

    recordingGateway(
      adapterCreator,
      history,
    )({
      onVoiceServerUpdate: ({ endpoint }) => received.push(`server ${endpoint}`),
      onVoiceStateUpdate: ({ channel_id }) => received.push(`state ${channel_id}`),
      destroy: () => undefined,
    });

    gateways[0]?.onVoiceServerUpdate({ guild_id: "guild", token: "token", endpoint: null });
    gateways[0]?.onVoiceStateUpdate(voiceState(OFFICE));

    assert.deepStrictEqual(received, ["server null", "state office"]);
    assert.deepStrictEqual(history.entries(), [
      "+0ms Discord sent the voice server without an endpoint",
      "+0ms Discord sent the voice state, in the channel",
    ]);
  });

  // Discord can send the voice server before the voice state. Released
  // @discordjs/voice ignores the state when it comes second, so the join waits
  // in signalling until it times out. patches/@discordjs__voice@0.19.2.patch
  // backports discordjs/discord.js#11581, which connects once both are in.
  it("connects when Discord sends the voice server before the voice state", () => {
    const { gateways, adapterCreator } = fakeDiscord();

    const connection = voice.joinVoiceChannel({
      guildId: "server-first",
      channelId: OFFICE,
      adapterCreator,
    });

    connection.on("error", () => undefined);

    try {
      gateways[0]?.onVoiceServerUpdate({
        guild_id: "server-first",
        token: "token",
        endpoint: "127.0.0.1:1",
      });

      assert.strictEqual(connection.state.status, VoiceConnectionStatus.Signalling);

      gateways[0]?.onVoiceStateUpdate(voiceState(OFFICE));

      assert.strictEqual(connection.state.status, VoiceConnectionStatus.Connecting);
    } finally {
      connection.destroy();
    }
  });
});
