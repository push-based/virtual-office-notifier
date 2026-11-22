import { Duration, Effect, Layer, Predicate, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { vi } from "vite-plus/test";

import { RetryTiming } from "./api/api.ts";
import { decodeJson, fakeApi, type SentRequest } from "./dev/fake-worker.ts";
import type { DiscordClient } from "./session/session.ts";

export interface FakeAnswer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeRoutes = (request: SentRequest) => FakeAnswer | "unanswered" | "hangs";

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

export const answeringOnce = (routes: FakeRoutes) =>
  Layer.mergeAll(
    fakeApi(fakeServer(routes).layer),
    Layer.succeed(RetryTiming, { retries: 0, delay: Duration.zero, timeout: Duration.seconds(5) }),
  );

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
