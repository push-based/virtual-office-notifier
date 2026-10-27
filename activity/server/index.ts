import { PgClient } from "@effect/sql-pg";
import { Context, DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema, String } from "effect";
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
import { SqlClient, type SqlError } from "effect/sql";

import {
  endsAt,
  ignoredReasonText,
  RecordingRequestBody,
  type RecordingStatus,
  type RequestResult,
  type SessionUser,
  type TokenResponse,
} from "../../src/Recording.ts";

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

class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

class DiscordRefused extends Schema.TaggedError<DiscordRefused>()("DiscordRefused", {
  status: Schema.Finite,
}) {}

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
  btoa(globalThis.String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const fromBase64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

const hmac = (secret: string, message: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

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

  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);

  return difference === 0;
};

const currentUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { sessionSecret } = yield* Settings;
  const header = request.headers["authorization"] ?? "";
  const [payload, signature] = header.replace(/^Bearer /, "").split(".");

  if (payload === undefined || signature === undefined) return yield* new Unauthorized();

  const expected = yield* hmac(Redacted.value(sessionSecret), payload);

  if (!sameBytes(expected, fromBase64url(signature))) return yield* new Unauthorized();

  const session = decodeSession(decoder.decode(fromBase64url(payload)));
  const now = yield* DateTime.now;

  if (Option.isNone(session) || session.value.exp < DateTime.toEpochMillis(now)) return yield* new Unauthorized();

  const user: SessionUser = { id: session.value.sub, name: session.value.name, avatarUrl: session.value.avatarUrl };

  return user;
});

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
    const response = yield* client.execute(request).pipe(Effect.mapError(() => new DiscordRefused({ status: 0 })));

    if (response.status < 200 || response.status >= 300) return yield* new DiscordRefused({ status: response.status });

    const body = yield* response.text.pipe(Effect.mapError(() => new DiscordRefused({ status: response.status })));

    return yield* decode(body).pipe(Effect.mapError(() => new DiscordRefused({ status: response.status })));
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
    HttpClientRequest.get(`${DISCORD_API}/users/@me`).pipe(HttpClientRequest.bearerToken(access_token)),
  );

  const sessionUser: SessionUser = {
    id: user.id,
    name: user.global_name ?? user.username,
    avatarUrl: avatarUrlOf(user),
  };

  return { accessToken: access_token, user: sessionUser };
});

const StatusRow = Schema.Struct({
  botInOffice: Schema.Boolean,
  occupants: Schema.Array(
    Schema.Struct({ userId: Schema.String, displayName: Schema.String, avatarUrl: Schema.NullOr(Schema.String) }),
  ),
  updatedAt: Schema.DateTimeUtcFromDate,
  recordingId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  startedBy: Schema.NullOr(Schema.String),
  startedByName: Schema.NullOr(Schema.String),
});

const decodeStatusRows = Schema.decodeUnknownEffect(Schema.Array(StatusRow));

const readStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* sql`
    SELECT s.bot_in_office, s.occupants, s.updated_at, r.id AS recording_id, r.started_at, r.started_by,
           coalesce(m.real_name, m.display_name) AS started_by_name
    FROM office.recording_status s
    LEFT JOIN office.recordings r ON r.id = s.recording_id AND r.stopped_at IS NULL
    LEFT JOIN office.members m ON m.user_id = r.started_by
  `.pipe(Effect.flatMap(decodeStatusRows));

  if (row === undefined) return yield* Effect.die("The recording status row is missing");

  const recording =
    row.recordingId === null || row.startedAt === null || row.startedBy === null
      ? null
      : {
          id: row.recordingId,
          startedAt: DateTime.formatIso(row.startedAt),
          startedByName: row.startedByName ?? row.startedBy,
          endsAt: DateTime.formatIso(endsAt({ id: row.recordingId, startedAt: row.startedAt, startedBy: row.startedBy })),
        };

  const status: RecordingStatus = {
    botInOffice: row.botInOffice,
    occupants: row.occupants,
    recording,
    updatedAt: DateTime.formatIso(row.updatedAt),
  };

  return status;
});

const RequestRow = Schema.Struct({
  id: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
  handledAt: Schema.NullOr(Schema.DateTimeUtcFromDate),
  outcome: Schema.NullOr(Schema.Literals(["started", "stopped", "ignored"])),
  reason: Schema.NullOr(Schema.String),
});

const decodeRequestRows = Schema.decodeUnknownEffect(Schema.Array(RequestRow));

const toResult = (row: typeof RequestRow.Type): RequestResult => ({
  id: row.id,
  handled: row.handledAt !== null,
  outcome: row.outcome,
  reason: row.reason,
  reasonText: row.reason === null ? null : ignoredReasonText(row.reason),
});

const insertRequest = (user: SessionUser, action: "start" | "stop") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`
      INSERT INTO office.recording_requests ${sql.insert({ requestedBy: user.id, requestedByName: user.name, action })}
      RETURNING id, handled_at, outcome, reason
    `.pipe(Effect.flatMap(decodeRequestRows));

    return rows[0] === undefined ? yield* Effect.die("The request wasn't inserted") : toResult(rows[0]);
  });

const findRequest = (user: SessionUser, id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`
      SELECT id, handled_at, outcome, reason FROM office.recording_requests
      WHERE id = ${id} AND requested_by = ${user.id}
    `.pipe(Effect.flatMap(decodeRequestRows));

    return Option.map(Option.fromUndefinedOr(rows[0]), toResult);
  });

const json = (body: RecordingStatus | RequestResult | TokenResponse | { readonly clientId: string } | { readonly error: string }, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status });

const databaseLayer = (url: string) =>
  PgClient.layer({
    url: Redacted.make(url),
    ssl: false,
    maxConnections: 1,
    applicationName: "virtual-office-recorder",
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  });

const withDatabase =
  (env: Env) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(databaseLayer(env.DATABASE.connectionString)), Effect.scoped);

const RequestId = Schema.Struct({ id: Schema.FiniteFromString });

type RouteFailure =
  | Unauthorized
  | DiscordRefused
  | Schema.SchemaError
  | SqlError.SqlError
  | HttpServerError.HttpServerError;

const responseFor = (failure: RouteFailure) =>
  Match.valueTags(failure, {
    Unauthorized: () => json({ error: "unauthorized" }, 401),
    DiscordRefused: ({ status }) => json({ error: `discord_${status}` }, 502),
    SchemaError: () => json({ error: "bad_request" }, 400),
    SqlError: () => json({ error: "database_unavailable" }, 503),
    HttpServerError: () => json({ error: "bad_request" }, 400),
  });

const answered = <E extends RouteFailure, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  handler.pipe(Effect.catch((failure) => Effect.succeed(responseFor(failure))));

const routes = (env: Env) => {
  const inDatabase = withDatabase(env);

  const settings = Layer.succeed(
    Settings,
    Settings.of({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: Redacted.make(env.DISCORD_CLIENT_SECRET),
      sessionSecret: Redacted.make(env.SESSION_SECRET),
    }),
  );

  const api = Layer.mergeAll(
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
    HttpRouter.add(
      "GET",
      "/api/state",
      answered(
        Effect.gen(function* () {
          yield* currentUser;

          return json(yield* inDatabase(readStatus));
        }),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/api/recording",
      answered(
        Effect.gen(function* () {
          const user = yield* currentUser;
          const { action } = yield* HttpServerRequest.schemaBodyJson(RecordingRequestBody);

          return json(yield* inDatabase(insertRequest(user, action)), 202);
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/api/requests/:id",
      answered(
        Effect.gen(function* () {
          const user = yield* currentUser;
          const { id } = yield* HttpRouter.schemaPathParams(RequestId);
          const found = yield* inDatabase(findRequest(user, id));

          return Option.match(found, {
            onNone: () => json({ error: "not_found" }, 404),
            onSome: (result) => json(result),
          });
        }),
      ),
    ),
    HttpRouter.add("*", "/api/*", json({ error: "not_found" }, 404)),
  );

  return api.pipe(
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
