import { NodeHttpClient } from "@effect/platform-node";
import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  pipe,
  Schema,
  String,
} from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

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

const AccessToken = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Finite });

type AccessToken = typeof AccessToken.Type;

const decodeToken = HttpClientResponse.schemaBodyJson(AccessToken);

const tokenLifetime = (exit: Exit.Exit<AccessToken, ArchiveError>): Duration.Duration =>
  Exit.isSuccess(exit)
    ? Duration.subtract(Duration.seconds(exit.value.expires_in), TOKEN_MARGIN)
    : Duration.zero;

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

        const storage = client.pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(STORAGE_URL)),
        );

        const fetchToken = HttpClientRequest.get(METADATA_TOKEN_URL).pipe(
          HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
          client.execute,
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(failed("Couldn't reach the metadata server")),
          Effect.flatMap(
            HttpClientResponse.matchStatus({
              200: (response) =>
                decodeToken(response).pipe(
                  Effect.catchTags({
                    HttpClientError: (error) =>
                      Effect.fail(failed("Couldn't read the metadata server's reply")(error)),
                    SchemaError: () =>
                      Effect.fail(archiveError("The metadata server's reply isn't a token")),
                  }),
                ),
              orElse: (response) =>
                Effect.fail(archiveError(`The metadata server answered HTTP ${response.status}`)),
            }),
          ),
        );

        const tokens = yield* Cache.makeWith(() => fetchToken, {
          capacity: 1,
          timeToLive: tokenLifetime,
        });

        const send = Effect.fnUntraced(function* (
          what: string,
          request: HttpClientRequest.HttpClientRequest,
        ) {
          const { access_token } = yield* Cache.get(tokens, undefined);

          return yield* storage.execute(HttpClientRequest.bearerToken(request, access_token)).pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.mapError(failed(what)),
            Effect.flatMap(
              HttpClientResponse.matchStatus({
                "2xx": (response) => Effect.succeed(response),
                orElse: (response) =>
                  Effect.fail(archiveError(`${what} answered HTTP ${response.status}`)),
              }),
            ),
          );
        });

        const upload = Effect.fn("ClipArchive.upload")(
          (path: string, audio: Uint8Array) =>
            send(
              "Uploading the clip",
              HttpClientRequest.post(`/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`).pipe(
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
              `/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`,
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
