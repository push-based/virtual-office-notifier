import { NodeHttpClient } from "@effect/platform-node";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Ref,
  Schema,
  String,
} from "effect";
import { HttpBody, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { RecordingConfig } from "./Config.ts";

export class ArchiveError extends Schema.TaggedError<
  ArchiveError,
  { readonly brand: unique symbol }
>()("ArchiveError", {
  reason: Schema.String,
}) {}

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const STORAGE_URL = "https://storage.googleapis.com";

const REQUEST_TIMEOUT = Duration.seconds(30);

const TOKEN_MARGIN = Duration.minutes(1);

const decodeToken = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ access_token: Schema.String, expires_in: Schema.Finite })),
);

interface CachedToken {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
}

export const objectPathOf = (
  recordingId: string,
  userId: string,
  startedAt: DateTime.Utc,
): string =>
  `recordings/${recordingId}/${userId}/${pipe(DateTime.formatIso(startedAt), String.replaceAll(":", "-"))}.ogg`;

const archiveError = (reason: string) => ArchiveError.make({ reason });

const failed = (what: string) => (error: Error) => archiveError(`${what}: ${error.message}`);

export class ClipArchive extends Context.Service<
  ClipArchive,
  {
    readonly bucket: Option.Option<string>;
    upload(path: string, audio: Uint8Array): Effect.Effect<void, ArchiveError>;
    download(path: string): Effect.Effect<Uint8Array, ArchiveError>;
  }
>()("bot/ClipArchive") {
  static readonly layerBucket = (bucket: string) =>
    Layer.effect(
      ClipArchive,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const cached = yield* Ref.make(Option.none<CachedToken>());

        const fetchToken = Effect.gen(function* () {
          const response = yield* HttpClientRequest.get(METADATA_TOKEN_URL).pipe(
            HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
            client.execute,
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError(failed("Couldn't reach the metadata server")),
          );

          if (response.status !== 200) {
            return yield* archiveError(`The metadata server answered HTTP ${response.status}`);
          }

          const body = yield* response.text.pipe(
            Effect.mapError(failed("Couldn't read the metadata server's reply")),
          );

          const { access_token, expires_in } = yield* decodeToken(body).pipe(
            Effect.mapError(() => archiveError("The metadata server's reply isn't a token")),
          );

          const now = yield* DateTime.now;

          const token: CachedToken = {
            token: access_token,
            expiresAt: DateTime.subtractDuration(
              DateTime.addDuration(now, Duration.seconds(expires_in)),
              TOKEN_MARGIN,
            ),
          };

          yield* Ref.set(cached, Option.some(token));

          return token;
        });

        const token = Effect.gen(function* () {
          const now = yield* DateTime.now;
          const current = yield* Ref.get(cached);

          return Option.isSome(current) && DateTime.isLessThan(now, current.value.expiresAt)
            ? current.value
            : yield* fetchToken;
        });

        const send = (what: string, request: HttpClientRequest.HttpClientRequest) =>
          Effect.gen(function* () {
            const { token: bearer } = yield* token;

            const response = yield* client
              .execute(HttpClientRequest.bearerToken(request, bearer))
              .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(failed(what)));

            if (response.status < 200 || response.status >= 300) {
              return yield* archiveError(`${what} answered HTTP ${response.status}`);
            }

            return response;
          });

        const upload = Effect.fn("ClipArchive.upload")(
          (path: string, audio: Uint8Array) =>
            send(
              "Uploading the clip",
              HttpClientRequest.post(
                `${STORAGE_URL}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`,
              ).pipe(
                HttpClientRequest.setUrlParams({ uploadType: "media", name: path }),
                HttpClientRequest.setBody(HttpBody.uint8Array(audio, "audio/ogg")),
              ),
            ),
          Effect.asVoid,
        );

        const readBody = (response: HttpClientResponse.HttpClientResponse) =>
          response.arrayBuffer.pipe(
            Effect.mapBoth({
              onSuccess: (buffer) => new Uint8Array(buffer),
              onFailure: failed("Reading the clip failed"),
            }),
          );

        const download = Effect.fn("ClipArchive.download")((path: string) =>
          send(
            "Downloading the clip",
            HttpClientRequest.get(
              `${STORAGE_URL}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
            ).pipe(HttpClientRequest.setUrlParams({ alt: "media" })),
          ).pipe(Effect.flatMap(readBody)),
        );

        return ClipArchive.of({ bucket: Option.some(bucket), upload, download });
      }),
    );

  static readonly layerDisabled = Layer.succeed(
    ClipArchive,
    ClipArchive.of({
      bucket: Option.none(),
      upload: () => Effect.fail(archiveError("No bucket is configured")),
      download: () => Effect.fail(archiveError("No bucket is configured")),
    }),
  );

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { bucket } = yield* RecordingConfig;

      return Option.match(bucket, {
        onNone: () =>
          Layer.effectDiscard(
            Effect.logInfo("RECORDINGS_BUCKET isn't set, so recorded clips aren't archived"),
          ).pipe(Layer.provideMerge(ClipArchive.layerDisabled)),
        onSome: ClipArchive.layerBucket,
      });
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
}
