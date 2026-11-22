import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { RecordingApi } from "office-domain/RecordingApi";
import type { Telemetry } from "office-domain/Telemetry";

export const TelemetryHandlers = (telemetry: Option.Option<Telemetry>) =>
  HttpApiBuilder.group(RecordingApi, "telemetry", (handlers) =>
    handlers.handle("config", () => Effect.succeed(Option.getOrNull(telemetry))),
  );
