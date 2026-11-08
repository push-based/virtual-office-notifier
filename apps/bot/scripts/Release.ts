import { Array, Effect, Predicate, String } from "effect";
import { Digest } from "effect/crypto";

export const RELEASE_FILE = "release";

const RELEASE_TAG = "SENTRY_RELEASE=";

export interface Release {
  readonly bundle: Uint8Array;
  readonly sourceMap: Uint8Array;
  readonly nativeVersion: string;
  readonly unit: string;
  readonly env: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

const isReleaseTag = String.startsWith(RELEASE_TAG);

const bytes = (content: Uint8Array | string): Uint8Array =>
  Predicate.isString(content) ? encoder.encode(content) : content;

const framed = (name: string, content: Uint8Array | string): ReadonlyArray<Uint8Array> => {
  const body = bytes(content);

  return [encoder.encode(`${name}\n${body.length}\n`), body, encoder.encode("\n")];
};

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const all = new Uint8Array(Array.reduce(chunks, 0, (total, chunk) => total + chunk.length));
  let offset = 0;

  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }

  return all;
};

export const releaseFingerprint = Effect.fnUntraced(function* ({
  bundle,
  sourceMap,
  nativeVersion,
  unit,
  env,
}: Release) {
  const digest = yield* Digest.Digest;

  const settings = Array.join(Array.filter(env, Predicate.not(isReleaseTag)), "\n");

  return yield* digest.digestHex(
    Digest.sha256,
    concat([
      ...framed("bundle", bundle),
      ...framed("source-map", sourceMap),
      ...framed("native", nativeVersion),
      ...framed("unit", unit),
      ...framed("env", settings),
    ]),
  );
});
