import { Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { Http } from "foldkit";

import { SessionToken } from "./api/api.ts";
import { Session } from "./session/session.ts";

export type Resources = HttpClient.HttpClient | SessionToken | Session;

const fetchedThroughSentry = Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
  globalThis.fetch(input, init),
);

export const resources: Layer.Layer<Resources> = Session.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Http.layer, SessionToken.layer)),
  Layer.provideMerge(fetchedThroughSentry),
);
