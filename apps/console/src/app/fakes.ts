import { Effect, Layer, Predicate, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiBuilder, HttpApiError, type HttpApiGroup } from "effect/http-api";
import { CurrentRequester, RecordingApi, SignedIn, Unauthorized } from "office-domain/RecordingApi";
import { vi } from "vite-plus/test";

import { bearerSession, ConsoleApi, SessionToken } from "./api/api.ts";
import { type DiscordClient, DiscordClients, Session } from "./session/session.ts";

export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly authorization: string | undefined;
  readonly body: Schema.Json;
}

export type FakeRoutes = (request: SentRequest) => FakeAnswer | "unanswered" | "hangs";

const decodeJson = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(Effect.orDie);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const bodyOf = (request: HttpClientRequest.HttpClientRequest): Effect.Effect<Schema.Json> =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? decodeJson(new TextDecoder().decode(request.body.body))
    : Effect.succeed(null);

const responseBodyOf = (answer: FakeAnswer): Effect.Effect<string | null> =>
  answer.body === undefined ? Effect.succeed(null) : encodeJson(answer.body).pipe(Effect.orDie);

export const fakeServer = (routes: FakeRoutes) => {
  const sent: Array<SentRequest> = [];

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const seen: SentRequest = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers["authorization"],
        body: yield* bodyOf(request),
      };

      sent.push(seen);

      const answer = routes(seen);

      if (answer === "hangs") return yield* Effect.never;

      if (answer === "unanswered") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        });
      }

      return HttpClientResponse.fromWeb(
        request,
        new Response(yield* responseBodyOf(answer), {
          status: answer.status ?? 200,
          headers: answer.headers ?? {},
        }),
      );
    }),
  );

  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

export const SESSION = "session-1";

export const ADA = { id: "u1", name: "Ada" };

const unavailable = () => Effect.fail(HttpApiError.ServiceUnavailable.make({}));

const signedInWithFakeSession = Layer.succeed(
  SignedIn,
  SignedIn.of({
    session: (httpEffect, { credential }) =>
      Redacted.value(credential) === SESSION
        ? Effect.provideService(httpEffect, CurrentRequester, ADA)
        : Effect.fail(Unauthorized.make()),
  }),
);

export const fakeSignIn = HttpApiBuilder.group(RecordingApi, "signIn", (handlers) =>
  handlers
    .handle("config", () => Effect.succeed({ clientId: "client-1" }))
    .handle("token", () =>
      Effect.succeed({
        accessToken: "access-1",
        session: SESSION,
        user: { ...ADA, avatarUrl: null },
      }),
    ),
);

type GroupName =
  | "telemetry"
  | "signIn"
  | "recording"
  | "stats"
  | "history"
  | "edits"
  | "consent"
  | "erasureAdmin";

export type FakeGroups = {
  readonly [Name in GroupName]?: Layer.Layer<
    HttpApiGroup.Service<"console", Name>,
    never,
    SignedIn
  >;
};

const unfaked = {
  telemetry: HttpApiBuilder.group(RecordingApi, "telemetry", (handlers) =>
    handlers.handle("config", () => Effect.succeed(null)),
  ),
  signIn: fakeSignIn,
  recording: HttpApiBuilder.group(RecordingApi, "recording", (handlers) =>
    handlers
      .handle("status", unavailable)
      .handle("submit", unavailable)
      .handle("find", unavailable),
  ),
  stats: HttpApiBuilder.group(RecordingApi, "stats", (handlers) =>
    handlers.handle("office", unavailable),
  ),
  history: HttpApiBuilder.group(RecordingApi, "history", (handlers) =>
    handlers.handle("recordings", unavailable).handle("recording", unavailable),
  ),
  edits: HttpApiBuilder.group(RecordingApi, "edits", (handlers) =>
    handlers.handle("submit", unavailable).handle("find", unavailable),
  ),
  consent: HttpApiBuilder.group(RecordingApi, "consent", (handlers) =>
    handlers
      .handle("status", unavailable)
      .handle("withdraw", unavailable)
      .handle("find", unavailable)
      .handle("erase", unavailable)
      .handle("findErasure", unavailable)
      .handle("cancelErasure", unavailable),
  ),
  erasureAdmin: HttpApiBuilder.group(RecordingApi, "erasureAdmin", (handlers) =>
    handlers
      .handle("cases", unavailable)
      .handle("expedite", unavailable)
      .handle("seen", unavailable)
      .handle("refuse", unavailable),
  ),
};

const seenBy = (request: Request): Effect.Effect<SentRequest> =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    const text = yield* Effect.promise(() => request.text());

    return {
      method: request.method,
      path: url.pathname,
      query: url.search,
      authorization: request.headers.get("authorization") ?? undefined,
      body: text === "" ? null : yield* decodeJson(text),
    };
  });

export const fakeWorker = (faked: FakeGroups = {}) => {
  const sent: Array<SentRequest> = [];

  const worker = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(RecordingApi).pipe(
      Layer.provide(
        Layer.mergeAll(
          faked.telemetry ?? unfaked.telemetry,
          faked.signIn ?? unfaked.signIn,
          faked.recording ?? unfaked.recording,
          faked.stats ?? unfaked.stats,
          faked.history ?? unfaked.history,
          faked.edits ?? unfaked.edits,
          faked.consent ?? unfaked.consent,
          faked.erasureAdmin ?? unfaked.erasureAdmin,
        ),
      ),
      Layer.provide(signedInWithFakeSession),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );

  const fetchFromWorker: typeof globalThis.fetch = (input, init) => {
    const request = new Request(
      new URL(input instanceof Request ? input.url : input, "http://console.test"),
      init,
    );

    return Effect.runPromise(
      seenBy(request.clone()).pipe(
        Effect.tap((seen) => Effect.sync(() => sent.push(seen))),
        Effect.andThen(Effect.promise(() => worker.handler(request))),
      ),
    );
  };

  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFromWorker)),
  );

  return { sent, layer, dispose: worker.dispose };
};

export const fakeDiscord = () => ({
  ready: vi.fn<DiscordClient["ready"]>().mockResolvedValue(undefined),
  commands: {
    authorize: vi
      .fn<DiscordClient["commands"]["authorize"]>()
      .mockResolvedValue({ code: "discord-code" }),
    authenticate: vi.fn<DiscordClient["commands"]["authenticate"]>(({ access_token }) =>
      Promise.resolve({
        access_token: access_token ?? "",
        user: { id: "u1", username: "ada", discriminator: "0", public_flags: 0, avatar: null },
        scopes: ["identify", "rpc.activities.write"],
        expires: "2026-10-28T12:00:00Z",
        application: { id: "client-1", name: "Console", description: "" },
      }),
    ),
    setActivity: vi.fn<DiscordClient["commands"]["setActivity"]>(({ activity }) =>
      Promise.resolve({ ...activity, type: 0, name: "Console" }),
    ),
    openExternalLink: vi
      .fn<DiscordClient["commands"]["openExternalLink"]>()
      .mockResolvedValue({ opened: true }),
  },
});

export type FakeDiscord = ReturnType<typeof fakeDiscord>;

export const fakeApi = (client: Layer.Layer<HttpClient.HttpClient>) =>
  ConsoleApi.layer.pipe(
    Layer.provide(bearerSession),
    Layer.provideMerge(SessionToken.layer),
    Layer.provide(client),
  );

export const fakeResources = (client: Layer.Layer<HttpClient.HttpClient>, discord: DiscordClient) =>
  Session.layer.pipe(
    Layer.provideMerge(fakeApi(client)),
    Layer.provide(Layer.succeed(DiscordClients, () => discord)),
  );
