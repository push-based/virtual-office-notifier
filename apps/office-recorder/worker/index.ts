import { PgClient } from "@effect/sql-pg";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  CurrentRequester,
  RecordingApi,
  type Requester,
  SignedIn,
  Unauthorized,
} from "recording-requests/RecordingApi";
import { RecordingHandlers } from "recording-requests/RecordingHandlers";
import { RecordingRequests, RecordingUnavailable } from "recording-requests/RecordingRequests";
import { columnNaming } from "recording-requests/SqlNaming";

interface Env {
  readonly DISCORD_CLIENT_ID: string;
  readonly DISCORD_CLIENT_SECRET: string;
  readonly DATABASE: Hyperdrive;
  readonly SESSION_SECRET: string;
}

const SESSION_LIFETIME = Duration.hours(12);

const DISCORD_API = "https://discord.com/api";

class Settings extends Context.Service<
  Settings,
  {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted<string>;
    readonly sessionSecret: Redacted.Redacted<string>;
  }
>()("virtual-office-recorder/Settings") {}

class DiscordRefused extends Schema.TaggedError<DiscordRefused>()("DiscordRefused", {
  status: Schema.Finite,
}) {}

interface SessionUser {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

interface TokenResponse {
  readonly accessToken: string;
  readonly session: string;
  readonly user: SessionUser;
}

const SessionPayload = Schema.Struct({
  sub: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  exp: Schema.Finite,
});

const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(SessionPayload));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

const base64url = (bytes: Uint8Array): string =>
  btoa(globalThis.String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

const hmac = (secret: string, message: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  });

const issueSession = Effect.fnUntraced(function* (user: SessionUser) {
  const { sessionSecret } = yield* Settings;
  const now = yield* DateTime.now;

  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        sub: user.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
        exp: DateTime.toEpochMillis(DateTime.addDuration(now, SESSION_LIFETIME)),
      }),
    ),
  );

  const signature = yield* hmac(Redacted.value(sessionSecret), payload);

  return `${payload}.${base64url(signature)}`;
});

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;

  let difference = 0;

  for (let index = 0; index < left.length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);

  return difference === 0;
};

const requesterOf = Effect.fnUntraced(function* (
  sessionSecret: Redacted.Redacted<string>,
  session: string,
) {
  const [payload, signature] = session.split(".");

  if (payload === undefined || signature === undefined) return yield* new Unauthorized();

  const expected = yield* hmac(Redacted.value(sessionSecret), payload);

  if (!sameBytes(expected, fromBase64url(signature))) return yield* new Unauthorized();

  const decoded = decodeSession(decoder.decode(fromBase64url(payload)));
  const now = yield* DateTime.now;

  if (Option.isNone(decoded) || decoded.value.exp < DateTime.toEpochMillis(now))
    return yield* new Unauthorized();

  const requester: Requester = { id: decoded.value.sub, name: decoded.value.name };

  return requester;
});

const SignedInLayer = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const { sessionSecret } = yield* Settings;

    return SignedIn.of({
      session: (httpEffect, { credential }) =>
        requesterOf(sessionSecret, Redacted.value(credential)).pipe(
          Effect.flatMap((requester) =>
            Effect.provideService(httpEffect, CurrentRequester, requester),
          ),
        ),
    });
  }),
);

const TokenBody = Schema.Struct({ code: Schema.NonEmptyString });

const DiscordToken = Schema.Struct({ access_token: Schema.String });

const DiscordUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  global_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeDiscordToken = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscordToken));

const decodeDiscordUser = Schema.decodeUnknownEffect(Schema.fromJsonString(DiscordUser));

const avatarUrlOf = (user: typeof DiscordUser.Type): string | null =>
  user.avatar === null || user.avatar === undefined
    ? null
    : `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;

const readDiscord = <A>(decode: (body: string) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
    const client = yield* HttpClient.HttpClient;

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new DiscordRefused({ status: 0 })));

    if (response.status < 200 || response.status >= 300)
      return yield* new DiscordRefused({ status: response.status });

    const body = yield* response.text.pipe(
      Effect.mapError(() => new DiscordRefused({ status: response.status })),
    );

    return yield* decode(body).pipe(
      Effect.mapError(() => new DiscordRefused({ status: response.status })),
    );
  });

const exchangeCode = Effect.fnUntraced(function* (code: string) {
  const { clientId, clientSecret } = yield* Settings;

  const { access_token } = yield* readDiscord(decodeDiscordToken)(
    HttpClientRequest.post(`${DISCORD_API}/oauth2/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: clientId,
        client_secret: Redacted.value(clientSecret),
        grant_type: "authorization_code",
        code,
      }),
    ),
  );

  const user = yield* readDiscord(decodeDiscordUser)(
    HttpClientRequest.get(`${DISCORD_API}/users/@me`).pipe(
      HttpClientRequest.bearerToken(access_token),
    ),
  );

  const sessionUser: SessionUser = {
    id: user.id,
    name: user.global_name ?? user.username,
    avatarUrl: avatarUrlOf(user),
  };

  return { accessToken: access_token, user: sessionUser };
});

const json = (
  body: TokenResponse | { readonly clientId: string } | { readonly error: string },
  status = 200,
) => HttpServerResponse.jsonUnsafe(body, { status });

type SignInFailure = DiscordRefused | Schema.SchemaError | HttpServerError.HttpServerError;

const responseFor = (failure: SignInFailure) =>
  Match.valueTags(failure, {
    DiscordRefused: ({ status }) => json({ error: `discord_${status}` }, 502),
    SchemaError: () => json({ error: "bad_request" }, 400),
    HttpServerError: () => json({ error: "bad_request" }, 400),
  });

const answered = <E extends SignInFailure, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => handler.pipe(Effect.catch((failure) => Effect.succeed(responseFor(failure))));

const connectionTo = (env: Env) =>
  PgClient.layer({
    url: Redacted.make(env.DATABASE.connectionString),
    ssl: false,
    maxConnections: 1,
    applicationName: "virtual-office-recorder",
    ...columnNaming,
  });

const recordingRequestsFor = (env: Env) => {
  const perCall = <A, E, R>(
    use: (requests: RecordingRequests["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const connection = yield* Layer.build(connectionTo(env)).pipe(
        Effect.mapError((error) => new RecordingUnavailable({ reason: error.message })),
      );

      const requests = yield* RecordingRequests.make(Effect.void).pipe(
        Effect.provideContext(connection),
      );

      return yield* use(requests);
    }).pipe(Effect.scoped);

  return Layer.succeed(
    RecordingRequests,
    RecordingRequests.of({
      submit: (requester, action) => perCall((requests) => requests.submit(requester, action)),
      find: (requester, id) => perCall((requests) => requests.find(requester, id)),
      status: perCall((requests) => requests.status),
      handlePending: (handler) => perCall((requests) => requests.handlePending(handler)),
      publishStatus: (update) => perCall((requests) => requests.publishStatus(update)),
    }),
  );
};

const routes = (env: Env) => {
  const settings = Layer.succeed(
    Settings,
    Settings.of({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: Redacted.make(env.DISCORD_CLIENT_SECRET),
      sessionSecret: Redacted.make(env.SESSION_SECRET),
    }),
  );

  const signIn = Layer.mergeAll(
    HttpRouter.add("GET", "/api/config", json({ clientId: env.DISCORD_CLIENT_ID })),
    HttpRouter.add(
      "POST",
      "/api/token",
      answered(
        Effect.gen(function* () {
          const { code } = yield* HttpServerRequest.schemaBodyJson(TokenBody);
          const { accessToken, user } = yield* exchangeCode(code);
          const session = yield* issueSession(user);

          return json({ accessToken, session, user });
        }),
      ),
    ),
  );

  const recording = HttpApiBuilder.layer(RecordingApi).pipe(
    Layer.provide(RecordingHandlers.pipe(Layer.provide(recordingRequestsFor(env)))),
    Layer.provideMerge(SignedInLayer),
  );

  const notFound = HttpRouter.add("*", "/api/*", json({ error: "not_found" }, 404));

  return Layer.mergeAll(signIn, recording, notFound).pipe(
    Layer.provideMerge(Layer.mergeAll(settings, FetchHttpClient.layer)),
    Layer.provide(HttpServer.layerServices),
  );
};

const makeApp = (env: Env) => HttpRouter.toWebHandler(routes(env), { disableLogger: true });

const apps = new WeakMap<Env, ReturnType<typeof makeApp>>();

const appFor = (env: Env) => {
  const existing = apps.get(env);

  if (existing !== undefined) return existing;

  const app = makeApp(env);

  apps.set(env, app);

  return app;
};

export default {
  fetch: (request: Request, env: Env): Promise<Response> => appFor(env).handler(request),
};
