import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";

export const QUERY_TIMEOUT = Duration.seconds(10);

export const TIMED_OUT = `Timed out after ${Duration.toSeconds(QUERY_TIMEOUT)} seconds`;

export interface QueryGuard<U> {
  readonly ready: Effect.Effect<void>;
  readonly unavailable: (reason: string) => U;
  readonly unreadable?: (reason: string) => U;
  readonly describe?: (error: Error) => string;
}

export interface Committable<E, R> {
  readonly afterCommit: Effect.Effect<void, E, R>;
}

export interface Connected<U> {
  <A, E, R>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, R>): Effect.Effect<A, E | U, R>;
}

const messageOf = (error: Error): string => error.message;

const timedOut = <U>(unavailable: (reason: string) => U) => ({
  duration: QUERY_TIMEOUT,
  orElse: () => Effect.fail(unavailable(TIMED_OUT)),
});

const classify =
  <U>({ unavailable, unreadable = unavailable, describe = messageOf }: QueryGuard<U>) =>
  (error: Error): U =>
    (Schema.isSchemaError(error) ? unreadable : unavailable)(describe(error));

export const guardQuery =
  <U>(guard: QueryGuard<U>) =>
  <A, E extends Error, R>(query: Effect.Effect<A, E, R>): Effect.Effect<A, U, R> =>
    guard.ready.pipe(
      Effect.andThen(query),
      Effect.mapError(classify(guard)),
      Effect.timeoutOrElse(timedOut(guard.unavailable)),
    );

export const guardChange =
  <U>(guard: QueryGuard<U>, sql: SqlClient.SqlClient) =>
  <A, E extends Error, R>(change: Effect.Effect<A, E, R>): Effect.Effect<A, U, R> =>
    Effect.serviceOption(sql.transactionService).pipe(
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.mapError(change, classify(guard)),
          onNone: () => guardQuery(guard)(sql.withTransaction(change)),
        }),
      ),
    );

export const guardTransaction =
  <U>(guard: QueryGuard<U>) =>
  <A extends Committable<E, R>, E, R>(
    sql: SqlClient.SqlClient,
    change: Effect.Effect<A, E, R>,
    resolve: (made: A) => Effect.Effect<unknown, SqlError.SqlError>,
    committed: Effect.Effect<void> = Effect.void,
  ): Effect.Effect<void, E | U, R> =>
    guard.ready.pipe(
      Effect.andThen(sql.withTransaction(Effect.tap(change, resolve))),
      Effect.catchIf(SqlError.isSqlError, (error) => Effect.fail(classify(guard)(error))),
      Effect.timeoutOrElse(timedOut(guard.unavailable)),
      Effect.tap(() => committed),
      Effect.flatMap((made) => made.afterCommit),
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
