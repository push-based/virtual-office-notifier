import { Context, Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from "effect/http-api";

import { RecordingStatus, RequestAction, SubmittedRequest } from "./RecordingRequest.ts";

export interface Requester {
  readonly id: string;
  readonly name: string;
}

export class CurrentRequester extends Context.Service<CurrentRequester, Requester>()(
  "recording-requests/RecordingApi/CurrentRequester",
) {}

export class Unauthorized extends Schema.TaggedError<
  Unauthorized,
  { readonly brand: unique symbol }
>()("Unauthorized", {}, { httpApiStatus: 401 }) {}

export class RequestNotFound extends Schema.TaggedError<
  RequestNotFound,
  { readonly brand: unique symbol }
>()("RequestNotFound", {}, { httpApiStatus: 404 }) {}

export class SignedIn extends HttpApiMiddleware.Service<SignedIn, { provides: CurrentRequester }>()(
  "recording-requests/SignedIn",
  {
    security: { session: HttpApiSecurity.bearer },
    error: Unauthorized,
    requiredForClient: true,
  },
) {}

export class RecordingGroup extends HttpApiGroup.make("recording")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      success: RecordingStatus,
      error: HttpApiError.ServiceUnavailable,
    }),
    HttpApiEndpoint.post("submit", "/requests", {
      payload: Schema.Struct({ action: RequestAction }),
      success: SubmittedRequest.pipe(HttpApiSchema.status(202)),
      error: HttpApiError.ServiceUnavailable,
    }),
    HttpApiEndpoint.get("find", "/requests/:id", {
      params: { id: Schema.Int },
      success: SubmittedRequest,
      error: [RequestNotFound, HttpApiError.ServiceUnavailable],
    }),
  )
  .middleware(SignedIn)
  .prefix("/api") {}

export class RecordingApi extends HttpApi.make("office-recorder").add(RecordingGroup) {}
