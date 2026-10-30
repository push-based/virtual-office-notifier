import { SignInGroup } from "activity-sign-in/SignInApi";
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

import { OfficeStats, StatsQuery } from "./OfficeStats.ts";
import { RecordingDetail, RecordingId, RecordingPage } from "./Recording.ts";
import { RecordingChange, SubmittedEdit } from "./RecordingEdit.ts";
import { RecordingStatus, RequestSubmission, SubmittedRequest } from "./RecordingRequest.ts";

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

export class RecordingNotFound extends Schema.TaggedError<
  RecordingNotFound,
  { readonly brand: unique symbol }
>()("RecordingNotFound", {}, { httpApiStatus: 404 }) {}

export class EditNotFound extends Schema.TaggedError<
  EditNotFound,
  { readonly brand: unique symbol }
>()("EditNotFound", {}, { httpApiStatus: 404 }) {}

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
      payload: RequestSubmission,
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

export class StatsGroup extends HttpApiGroup.make("stats")
  .add(
    HttpApiEndpoint.get("office", "/stats", {
      query: StatsQuery,
      success: OfficeStats,
      error: HttpApiError.ServiceUnavailable,
    }),
  )
  .middleware(SignedIn)
  .prefix("/api") {}

export class HistoryGroup extends HttpApiGroup.make("history")
  .add(
    HttpApiEndpoint.get("recordings", "/recordings", {
      query: { before: Schema.optional(Schema.DateTimeUtcFromString) },
      success: RecordingPage,
      error: HttpApiError.ServiceUnavailable,
    }),
    HttpApiEndpoint.get("recording", "/recordings/:id", {
      params: { id: RecordingId },
      success: RecordingDetail,
      error: [RecordingNotFound, HttpApiError.ServiceUnavailable],
    }),
  )
  .middleware(SignedIn)
  .prefix("/api") {}

export class EditGroup extends HttpApiGroup.make("edits")
  .add(
    HttpApiEndpoint.post("submit", "/recordings/:id/edits", {
      params: { id: RecordingId },
      payload: RecordingChange,
      success: SubmittedEdit.pipe(HttpApiSchema.status(202)),
      error: [RecordingNotFound, HttpApiError.ServiceUnavailable],
    }),
    HttpApiEndpoint.get("find", "/edits/:id", {
      params: { id: Schema.Int },
      success: SubmittedEdit,
      error: [EditNotFound, HttpApiError.ServiceUnavailable],
    }),
  )
  .middleware(SignedIn)
  .prefix("/api") {}

export class RecordingApi extends HttpApi.make("console")
  .add(SignInGroup.prefix("/api"))
  .add(RecordingGroup)
  .add(StatsGroup)
  .add(HistoryGroup)
  .add(EditGroup) {}
