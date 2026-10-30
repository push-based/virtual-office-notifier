import { Context, Duration, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

export const QUERY_TIMEOUT = Duration.seconds(10);

const TIMED_OUT = `Timed out after ${Duration.toSeconds(QUERY_TIMEOUT)} seconds`;

export interface QueryGuard<U> {
  readonly ready: Effect.Effect<void>;
  readonly unavailable: (reason: string) => U;
  readonly unreadable?: (reason: string) => U;
  readonly describe?: (error: Error) => string;
}

export interface Connected<U> {
  <A, E, R>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>): Effect.Effect<A, E | U, R>;
}

const messageOf = (error: Error): string => error.message;

export const guardQuery =
  <U>({ ready, unavailable, unreadable = unavailable, describe = messageOf }: QueryGuard<U>) =>
  <A, E extends Error, R>(query: Effect.Effect<A, E, R>): Effect.Effect<A, U, R> =>
    ready.pipe(
      Effect.andThen(query),
      Effect.mapError((error) =>
        (Schema.isSchemaError(error) ? unreadable : unavailable)(describe(error)),
      ),
      Effect.timeoutOrElse({
        duration: QUERY_TIMEOUT,
        orElse: () => Effect.fail(unavailable(TIMED_OUT)),
      }),
    );

export const connectedTo =
  (sql: SqlClient.SqlClient): Connected<never> =>
  (use) =>
    use(sql);

export const connectedPerCall =
  <U, E extends Error>(
    connection: Layer.Layer<SqlClient.SqlClient, E>,
    unavailable: (reason: string) => U,
  ): Connected<U> =>
  (use) =>
    Effect.scopedWith((scope) =>
      Layer.buildWithScope(Layer.fresh(connection), scope).pipe(
        Effect.mapError((error) => unavailable(error.message)),
        Effect.flatMap((context) => use(Context.get(context, SqlClient.SqlClient))),
      ),
    );
