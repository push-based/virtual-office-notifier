import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { Transcriber } from "../src/Transcriber.ts";
import { makeFakeSlackHttp, type Reply, requestJson, respond } from "./fakes.ts";

const audio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3]);

const makeTranscriber = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const http = yield* makeFakeSlackHttp(replies);

  const transcriber = yield* Effect.service(Transcriber).pipe(
    Effect.provide(
      Transcriber.layerOptions({
        accountId: Redacted.make("acc-123"),
        apiToken: Redacted.make("cf-token"),
        model: "@cf/openai/whisper-large-v3-turbo",
        language: "en",
      }).pipe(Layer.provide(http.layer)),
    ),
  );

  return { transcriber, requests: http.requests };
});

const success = (text: string): Reply =>
  respond(200, JSON.stringify({ success: true, result: { text } }));

describe("Transcriber", () => {
  it.effect("sends the audio as base64 with the language, and returns the trimmed text", () =>
    Effect.gen(function* () {
      const { transcriber, requests } = yield* makeTranscriber([success("  Hello there. ")]);

      const transcript = yield* transcriber.transcribe(audio);

      assert.deepStrictEqual(transcript, {
        text: "Hello there.",
        model: "@cf/openai/whisper-large-v3-turbo",
      });

      const [request] = yield* requests;
      assert.strictEqual(
        request?.url,
        "https://api.cloudflare.com/client/v4/accounts/acc-123/ai/run/@cf/openai/whisper-large-v3-turbo",
      );
      assert.strictEqual(request?.headers["authorization"], "Bearer cf-token");
      assert.deepStrictEqual(requestJson(request!), {
        audio: "T2dnUwABAgM=",
        task: "transcribe",
        language: "en",
      });
    }),
  );

  it.effect("tells the daily limit apart from other refusals", () =>
    Effect.gen(function* () {
      const { transcriber } = yield* makeTranscriber([
        respond(
          429,
          JSON.stringify({ success: false, errors: [{ code: 4006, message: "Daily limit" }] }),
        ),
      ]);

      const error = yield* transcriber.transcribe(audio).pipe(Effect.flip);

      assert.strictEqual(error.failure, "DailyLimit");
    }),
  );

  it.effect.each([429, 500, 503])("treats HTTP %s as the transcriber being unavailable", (status) =>
    Effect.gen(function* () {
      const { transcriber } = yield* makeTranscriber([respond(status, "")]);

      const error = yield* transcriber.transcribe(audio).pipe(Effect.flip);

      assert.strictEqual(error.failure, "Unavailable");
      assert.include(error.detail, String(status));
    }),
  );

  it.effect("treats a 4xx as the clip being rejected", () =>
    Effect.gen(function* () {
      const { transcriber } = yield* makeTranscriber([
        respond(
          400,
          JSON.stringify({ success: false, errors: [{ code: 7000, message: "bad audio" }] }),
        ),
      ]);

      const error = yield* transcriber.transcribe(audio).pipe(Effect.flip);

      assert.strictEqual(error.failure, "Rejected");
      assert.include(error.detail, "bad audio");
    }),
  );

  it.effect("fails as unreadable when the reply isn't a transcription", () =>
    Effect.gen(function* () {
      const { transcriber } = yield* makeTranscriber([respond(200, "<html>")]);

      const error = yield* transcriber.transcribe(audio).pipe(Effect.flip);

      assert.strictEqual(error.failure, "Unreadable");
    }),
  );

  it.effect("fails as unavailable when nothing is configured", () =>
    Effect.gen(function* () {
      const transcriber = yield* Effect.service(Transcriber).pipe(
        Effect.provide(Transcriber.layerNone),
      );

      const error = yield* transcriber.transcribe(audio).pipe(Effect.flip);

      assert.strictEqual(error.failure, "Unavailable");
    }),
  );
});
