import * as Sentry from "@sentry/cloudflare";
import {
  Array,
  Cause,
  Effect,
  ErrorReporter,
  Formatter,
  Layer,
  Logger,
  Option,
  Predicate,
  String,
} from "effect";
import { HttpRouter } from "effect/http";
import type { Severity } from "effect/LogLevel";

export interface SentryEnv {
  readonly SENTRY_DSN?: string;
  readonly SENTRY_ENVIRONMENT?: string;
  readonly SENTRY_RELEASE?: string;
}

export interface Telemetry {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string | null;
}

export const TUNNEL_PATH = "/api/sentry";

const nonEmpty = (value: string | undefined) =>
  Option.fromNullishOr(value).pipe(Option.filter(String.isNonEmpty));

export const telemetryFrom = (env: SentryEnv): Option.Option<Telemetry> =>
  Option.map(nonEmpty(env.SENTRY_DSN), (dsn) => ({
    dsn,
    environment: Option.getOrElse(nonEmpty(env.SENTRY_ENVIRONMENT), () => "development"),
    release: Option.getOrNull(nonEmpty(env.SENTRY_RELEASE)),
  }));

const NOTHING_PERSONAL: Sentry.CloudflareOptions["dataCollection"] = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
};

export const sentryOptions = (env: SentryEnv): Sentry.CloudflareOptions =>
  Option.match(telemetryFrom(env), {
    onNone: () => ({ dsn: "" }),
    onSome: ({ dsn, environment, release }) => ({
      dsn,
      environment,
      release: release ?? undefined,
      tracesSampler: ({ attributes }) => (attributes?.["url.path"] === TUNNEL_PATH ? 0 : 1),
      enableLogs: true,
      dataCollection: NOTHING_PERSONAL,
      integrations: (defaults) => Array.filter(defaults, ({ name }) => name !== "Console"),
    }),
  });

const LEVELS: Record<Severity, Sentry.SeverityLevel> = {
  Fatal: "fatal",
  Error: "error",
  Warn: "warning",
  Info: "info",
  Debug: "debug",
  Trace: "debug",
};

const report = (reason: Cause.Fail<unknown> | Cause.Die) => {
  const error = Cause.isFailReason(reason) ? reason.error : reason.defect;

  if (ErrorReporter.isIgnored(error)) return;

  Sentry.captureException(error, {
    level: Predicate.hasProperty(error, ErrorReporter.severity)
      ? LEVELS[ErrorReporter.getSeverity(error)]
      : "error",
    extra: Predicate.isObject(error) ? { ...ErrorReporter.getAttributes(error) } : {},
  });
};

const makeSentryErrorReporter = (): ErrorReporter.ErrorReporter => {
  const reported = new WeakSet<Cause.Cause<unknown>>();

  return {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: ({ cause }) => {
      if (reported.has(cause)) return;

      reported.add(cause);

      for (const reason of cause.reasons) {
        if (!Cause.isInterruptReason(reason)) report(reason);
      }
    },
  };
};

const LOGGERS: Record<Severity, (message: string) => void> = {
  Fatal: (message) => Sentry.logger.fatal(message),
  Error: (message) => Sentry.logger.error(message),
  Warn: (message) => Sentry.logger.warn(message),
  Info: (message) => Sentry.logger.info(message),
  Debug: (message) => Sentry.logger.debug(message),
  Trace: (message) => Sentry.logger.trace(message),
};

const SentryLogger = Logger.make(({ logLevel, message }) => {
  if (logLevel === "All" || logLevel === "None") return;

  const parts = Array.map(Array.ensure(message), (part) =>
    Predicate.isString(part) ? part : Formatter.format(part),
  );

  LOGGERS[logLevel](Array.join(parts, " "));
});

const nameRequestSpan = (method: string, path: string) =>
  Effect.sync(() => {
    const span = Sentry.getActiveSpan();

    if (span !== undefined) Sentry.updateSpanName(Sentry.getRootSpan(span), `${method} ${path}`);
  });

export const RouteSpanNames = HttpRouter.middleware((httpEffect) =>
  Effect.gen(function* () {
    const { route } = yield* HttpRouter.RouteContext;

    yield* nameRequestSpan(route.method, route.path);

    return yield* httpEffect;
  }),
);

export const ObservabilityLayer = Layer.mergeAll(
  ErrorReporter.layer([makeSentryErrorReporter()], { mergeWithExisting: true }),
  Logger.layer([SentryLogger], { mergeWithExisting: true }),
);
