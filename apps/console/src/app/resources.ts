import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Http } from "foldkit";

import { bearerSession, ConsoleApi, SessionToken } from "./api/api.ts";
import { Session } from "./session/session.ts";

export type Resources = ConsoleApi | SessionToken | Session;

const fetchedThroughSentry = Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
  globalThis.fetch(input, init),
);

export const resources: Layer.Layer<Resources> = Session.layer.pipe(
  Layer.provideMerge(ConsoleApi.layer.pipe(Layer.provide(bearerSession))),
  Layer.provideMerge(SessionToken.layer),
  Layer.provideMerge(Http.layer),
  Layer.provideMerge(fetchedThroughSentry),
);
