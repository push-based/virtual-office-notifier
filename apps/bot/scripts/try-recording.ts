import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  Redacted,
  Schema,
  String,
} from "effect";
import { Client, Events, GatewayIntentBits } from "discord.js";
import type { Buffer } from "node:buffer";

import { AiConfig, DiscordConfig, RecordingConfig } from "../src/Config.ts";
import { oggOpusFile, opusPacketsDuration } from "../src/recording/audio/OggOpus.ts";
import { Transcriber } from "../src/recording/Transcriber.ts";

// Joins the office with audio on, writes one Ogg/Opus file per stretch of
// speech, and sends the first long enough clip to Workers AI Whisper. It
// confirms the two things the recording feature depends on: that received
// audio decrypts with DAVE, and that Whisper accepts Ogg/Opus as is.
//
//   node --env-file=.env scripts/try-recording.ts [--seconds 60] [--out recordings-check]

class CheckFailed extends Schema.TaggedError<CheckFailed, { readonly brand: unique symbol }>()(
  "CheckFailed",
  {
    message: Schema.String,
  },
) {}

const argument = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);

  return index === -1 ? undefined : process.argv[index + 1];
};

const program = Effect.gen(function* () {
  const effectContext = yield* Effect.context<never>();
  const runInBackground = Effect.runForkWith(effectContext);

  const { botToken, officeChannelId } = yield* DiscordConfig;
  const { cloudflare } = yield* AiConfig;
  const { whisperModel, language } = yield* RecordingConfig;
  const seconds = Number(argument("--seconds") ?? "60");
  const out = argument("--out") ?? "recordings-check";
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(out, { recursive: true });

  const transcriber = Option.map(
    Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken }),
    ({ accountId, apiToken }) =>
      Transcriber.layerOptions({ accountId, apiToken, model: whisperModel, language }).pipe(
        Layer.provide(NodeHttpClient.layerUndici),
      ),
  );

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  const ready = yield* Effect.callback<Client<true>, CheckFailed>((resume) => {
    client.once(Events.ClientReady, (ready) => resume(Effect.succeed(ready)));
    client
      .login(Redacted.value(botToken))
      .catch((cause: Error) => resume(Effect.fail(CheckFailed.make({ message: cause.message }))));
  });

  yield* Effect.addFinalizer(() => Effect.promise(() => client.destroy()));

  const channel = ready.channels.cache.get(officeChannelId);

  if (channel === undefined || !channel.isVoiceBased()) {
    return yield* CheckFailed.make({
      message: `Channel ${officeChannelId} isn't a voice channel the bot can see`,
    });
  }

  yield* Effect.log(
    `Joining #${channel.name} with audio on for ${seconds} seconds. Say something!`,
  );

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    debug: true,
  });

  connection.on("debug", (message) => {
    if (/dave|e2ee|mls/i.test(message)) runInBackground(Effect.log(`[voice] ${message}`));
  });
  connection.on("error", (error) => runInBackground(Effect.logError("[voice] error", error)));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    }),
  );

  yield* Effect.tryPromise({
    try: () => entersState(connection, VoiceConnectionStatus.Ready, 20_000),
    catch: (cause) =>
      CheckFailed.make({ message: `Couldn't connect to voice: ${globalThis.String(cause)}` }),
  });

  yield* Effect.log("Voice connection ready. Decryption failures would show up as warnings below.");

  const receiver = connection.receiver;
  let clips = 0;
  let firstTranscribable: Uint8Array | undefined;

  receiver.speaking.on("start", (userId) => {
    if (receiver.subscriptions.has(userId)) return;

    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
    });

    const packets: Array<Uint8Array> = [];
    const name = channel.guild.members.cache.get(userId)?.displayName ?? userId;

    runInBackground(Effect.log(`[clip] ${name} started speaking`));

    stream.on("data", (packet: Buffer) => packets.push(new Uint8Array(packet)));
    stream.on("end", () => {
      const durationMs = opusPacketsDuration(packets);
      const ogg = oggOpusFile(packets);

      clips += 1;

      runInBackground(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const fileName = pipe(name, String.replaceAll(/[^\w-]/g, "_"));
          const file = path.join(out, `${fileName}-${now}.ogg`);

          yield* Effect.log(
            `[clip] ${name}: ${packets.length} packets, ${durationMs} ms, ${ogg.length} bytes -> ${file}`,
          );

          yield* fs
            .writeFile(file, ogg)
            .pipe(Effect.catch((error) => Effect.logError("[clip] write failed", error.message)));
        }),
      );

      if (firstTranscribable === undefined && durationMs >= 1000) firstTranscribable = ogg;
    });
  });

  yield* Effect.sleep(Duration.seconds(seconds));

  yield* Effect.log(`Done listening. ${clips} clip(s) written to ${out}.`);

  if (clips === 0) {
    yield* Effect.logWarning(
      "No clips arrived. If someone spoke, received audio probably isn't decrypting: check the [voice] lines above for DAVE errors.",
    );
  }

  if (firstTranscribable === undefined) {
    yield* Effect.log("No clip of at least a second to transcribe.");

    return;
  }

  yield* Option.match(transcriber, {
    onNone: () => Effect.log("Cloudflare isn't configured, so the clip wasn't sent to Whisper."),
    onSome: (layer) =>
      Effect.gen(function* () {
        const whisper = yield* Transcriber;
        const audio = firstTranscribable ?? new Uint8Array();

        yield* Effect.log(
          `Sending the first clip (${audio.length} bytes of Ogg/Opus) to ${whisperModel}`,
        );

        const transcript = yield* whisper.transcribe(audio);

        yield* Effect.log(`Whisper accepted Ogg/Opus and heard: "${transcript.text}"`);
      }).pipe(
        Effect.provide(layer),
        Effect.catchTag("TranscriptionError", (error) =>
          Effect.logError(`Whisper refused the clip: ${error.failure} (${error.detail})`),
        ),
      ),
  });
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
