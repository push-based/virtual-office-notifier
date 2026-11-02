import {
  NetworkingStatusCode,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { assert, describe, it } from "@effect/vitest";

import {
  connectionStep,
  describeVoiceServer,
  describeVoiceState,
  startJoinHistory,
} from "../../../src/recording/audio/JoinHistory.ts";

const clockAt = (times: ReadonlyArray<number>) => {
  let next = 0;

  return () => times[Math.min(next++, times.length - 1)] ?? 0;
};

describe("JoinHistory", () => {
  it("names the step a connection is at", () => {
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

  it("says why a connection was dropped", () => {
    assert.strictEqual(
      connectionStep({
        status: VoiceConnectionStatus.Disconnected,
        reason: VoiceConnectionDisconnectReason.WebSocketClose,
        closeCode: 4014,
      }),
      "disconnected (voice WebSocket closed with 4014)",
    );
    assert.strictEqual(
      connectionStep({
        status: VoiceConnectionStatus.Disconnected,
        reason: VoiceConnectionDisconnectReason.EndpointRemoved,
      }),
      "disconnected (voice server removed)",
    );
  });

  it("tells apart whether Discord's voice details made it", () => {
    assert.strictEqual(
      describeVoiceServer({ endpoint: "c-fra.discord.media" }),
      "Discord sent the voice server",
    );
    assert.strictEqual(
      describeVoiceServer({ endpoint: null }),
      "Discord sent the voice server without an endpoint",
    );
    assert.strictEqual(
      describeVoiceState({ channel_id: null }),
      "Discord sent the voice state, out of the channel",
    );
  });

  it("notes each event with the time since the join began", () => {
    const history = startJoinHistory(clockAt([1000, 1000, 1120, 21_000]));

    history.record("asked Discord to join the office");
    history.record("Discord sent the voice state, in the channel");
    history.step({ status: VoiceConnectionStatus.Signalling });

    assert.deepStrictEqual(history.entries(), [
      "+0ms asked Discord to join the office",
      "+120ms Discord sent the voice state, in the channel",
      "+20000ms signalling",
    ]);
  });

  it("notes a step only when it changes", () => {
    const history = startJoinHistory(() => 0);

    const identifying = {
      status: VoiceConnectionStatus.Connecting,
      networking: { state: { code: NetworkingStatusCode.Identifying } },
    };

    history.step(identifying);
    history.step(identifying);
    history.step({ ...identifying, networking: { state: { code: NetworkingStatusCode.Ready } } });

    assert.deepStrictEqual(history.entries(), [
      "+0ms connecting (identifying)",
      "+0ms connecting (ready)",
    ]);
  });

  it("keeps only the latest events", () => {
    const history = startJoinHistory(() => 0, 2);

    history.record("one");
    history.record("two");
    history.record("three");

    assert.deepStrictEqual(history.entries(), ["+0ms two", "+0ms three"]);
  });
});
