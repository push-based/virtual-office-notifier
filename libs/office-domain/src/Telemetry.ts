import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

export const TUNNEL_PATH = "/api/sentry";

export const Telemetry = Schema.Struct({
  dsn: Schema.String,
  environment: Schema.String,
  release: Schema.NullOr(Schema.String),
});

export type Telemetry = typeof Telemetry.Type;

export class TelemetryGroup extends HttpApiGroup.make("telemetry")
  .add(HttpApiEndpoint.get("config", "/telemetry", { success: Schema.NullOr(Telemetry) }))
  .prefix("/api") {}
