import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { ClipArchive, objectPathOf } from "../src/ClipArchive.ts";
import { makeFakeSlackHttp, type Reply, requestText, respond } from "./fakes.ts";

const token = (accessToken: string, expiresIn = 3600): Reply =>
  respond(
    200,
    JSON.stringify({ access_token: accessToken, expires_in: expiresIn, token_type: "Bearer" }),
  );

const audio = new Uint8Array([1, 2, 3]);

const makeArchive = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const http = yield* makeFakeSlackHttp(replies);

  const archive = yield* Effect.service(ClipArchive).pipe(
    Effect.provide(ClipArchive.layerBucket("office-recordings").pipe(Layer.provide(http.layer))),
  );

  return { archive, requests: http.requests };
});

describe("objectPathOf", () => {
  it("files clips by recording and speaker, with a filename safe for storage", () => {
    assert.strictEqual(
      objectPathOf("rec-1", "u1", DateTime.makeUnsafe("2026-10-24T10:02:03.456Z")),
      "recordings/rec-1/u1/2026-10-24T10-02-03.456Z.ogg",
    );
  });
});

describe("ClipArchive", () => {
  it.effect("gets a token from the metadata server and uploads with it", () =>
    Effect.gen(function* () {
      const { archive, requests } = yield* makeArchive([token("tok-1"), respond(200, "{}")]);

      assert.deepStrictEqual(archive.bucket, Option.some("office-recordings"));

      yield* archive.upload("recordings/r/u/clip.ogg", audio);

      const [metadata, upload] = yield* requests;
      assert.strictEqual(
        metadata?.url,
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      );
      assert.strictEqual(metadata?.headers["metadata-flavor"], "Google");
      assert.strictEqual(
        upload?.url,
        "https://storage.googleapis.com/upload/storage/v1/b/office-recordings/o",
      );
      assert.deepStrictEqual(
        [...(upload?.urlParams ?? [])],
        [
          ["uploadType", "media"],
          ["name", "recordings/r/u/clip.ogg"],
        ],
      );
      assert.strictEqual(upload?.headers["authorization"], "Bearer tok-1");
      assert.strictEqual(upload?.headers["content-type"], "audio/ogg");
      assert.strictEqual(requestText(upload!), "\u0001\u0002\u0003");
    }),
  );

  it.effect("reuses the token until it's about to expire", () =>
    Effect.gen(function* () {
      const { archive, requests } = yield* makeArchive([
        token("tok-1", 120),
        respond(200, "{}"),
        respond(200, "{}"),
        token("tok-2"),
        respond(200, "{}"),
      ]);

      yield* archive.upload("a.ogg", audio);
      yield* archive.upload("b.ogg", audio);
      yield* TestClock.adjust("61 seconds");
      yield* archive.upload("c.ogg", audio);

      const sent = yield* requests;
      assert.deepStrictEqual(
        sent.map((request) => request.headers["authorization"] ?? "token request"),
        ["token request", "Bearer tok-1", "Bearer tok-1", "token request", "Bearer tok-2"],
      );
    }),
  );

  it.effect("downloads a clip's bytes", () =>
    Effect.gen(function* () {
      const { archive, requests } = yield* makeArchive([token("tok-1"), respond(200, "OggS")]);

      const bytes = yield* archive.download("recordings/r/u/clip.ogg");

      assert.strictEqual(new TextDecoder().decode(bytes), "OggS");

      const [, download] = yield* requests;
      assert.strictEqual(
        download?.url,
        "https://storage.googleapis.com/storage/v1/b/office-recordings/o/recordings%2Fr%2Fu%2Fclip.ogg",
      );
      assert.deepStrictEqual([...(download?.urlParams ?? [])], [["alt", "media"]]);
    }),
  );

  it.effect("fails with the status when storage refuses", () =>
    Effect.gen(function* () {
      const { archive } = yield* makeArchive([token("tok-1"), respond(403, "forbidden")]);

      const error = yield* archive.upload("a.ogg", audio).pipe(Effect.flip);

      assert.strictEqual(error.reason, "Uploading the clip answered HTTP 403");
    }),
  );

  it.effect("fails when there's no token to be had", () =>
    Effect.gen(function* () {
      const { archive } = yield* makeArchive([respond(404, "not on GCE")]);

      const error = yield* archive.upload("a.ogg", audio).pipe(Effect.flip);

      assert.strictEqual(error.reason, "The metadata server answered HTTP 404");
    }),
  );

  it.effect("has no bucket and refuses everything when disabled", () =>
    Effect.gen(function* () {
      const archive = yield* Effect.service(ClipArchive).pipe(
        Effect.provide(ClipArchive.layerDisabled),
      );

      assert.deepStrictEqual(archive.bucket, Option.none());

      const error = yield* archive.download("a.ogg").pipe(Effect.flip);
      assert.strictEqual(error.reason, "No bucket is configured");
    }),
  );
});
