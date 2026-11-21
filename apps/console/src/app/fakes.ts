import { Effect, Layer, Predicate, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { vi } from "vite-plus/test";

import { SessionToken } from "./api/api.ts";
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

export type FakeRoutes = (request: SentRequest) => FakeAnswer | "unanswered";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const bodyOf = (request: HttpClientRequest.HttpClientRequest): Schema.Json =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? decodeJson(new TextDecoder().decode(request.body.body))
    : null;

export const fakeServer = (routes: FakeRoutes) => {
  const sent: Array<SentRequest> = [];

  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const seen: SentRequest = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers["authorization"],
        body: bodyOf(request),
      };

      sent.push(seen);

      const answer = routes(seen);

      if (answer === "unanswered") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
          }),
        );
      }

      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
            status: answer.status ?? 200,
            headers: answer.headers ?? {},
          }),
        ),
      );
    }),
  );

  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
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

export const fakeResources = (server: ReturnType<typeof fakeServer>, discord: DiscordClient) =>
  Session.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(server.layer, SessionToken.layer)),
    Layer.provide(Layer.succeed(DiscordClients, () => discord)),
  );
