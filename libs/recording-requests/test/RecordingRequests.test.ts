import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Tracer,
} from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { connectedTo, QUERY_TIMEOUT } from "../src/Query.ts";
import { RecordingRequests, type RequestHandler } from "../src/RecordingRequests.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import { migrated } from "./schema.ts";

class ConnectionRefused extends Schema.TaggedError<
  ConnectionRefused,
  { readonly brand: unique symbol }
>()("ConnectionRefused", { message: Schema.String }) {}

interface Connections {
  opened: number;
  closed: number;
}

const ada = { id: "u1", name: "Ada" };

const emptyOffice: RequestHandler<never, never> = {
  situation: Effect.succeed({ occupants: new Set<string>(), active: Option.none() }),
  start: () => Effect.die("The office is empty"),
  stop: () => Effect.die("The office is empty"),
  pause: () => Effect.die("The office is empty"),
  resume: () => Effect.die("The office is empty"),
};

class CameraBroken extends Schema.TaggedError<CameraBroken, { readonly brand: unique symbol }>()(
  "CameraBroken",
  {},
) {}

const RECORDING = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

const adaStarting = (
  sql: SqlClient.SqlClient,
  committed: Ref.Ref<boolean>,
): RequestHandler<never, never> => ({
  ...emptyOffice,
  situation: Effect.succeed({ occupants: new Set([ada.id]), active: Option.none() }),
  start: () =>
    sql`
      INSERT INTO office.recordings (id, guild_id, channel_id, started_at, started_by)
      VALUES (${RECORDING}, 'guild', 'office', now(), ${ada.id})
    `.pipe(
      Effect.orDie,
      Effect.as({ recordingId: RECORDING, afterCommit: Ref.set(committed, true) }),
    ),
});

const stallingBeforeCommit = (
  sql: SqlClient.SqlClient,
  stalled: Deferred.Deferred<void>,
): SqlClient.SqlClient =>
  Object.assign(sql.bind(undefined), sql, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(
        effect.pipe(
          Effect.andThen(Deferred.succeed(stalled, undefined)),
          Effect.andThen(Effect.never),
        ),
      ),
  });

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* migrated;
  yield* sql`
    INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
    VALUES (${ada.id}, ${ada.name}, now(), now())
  `;

  return sql;
});

const countedConnection = (sql: SqlClient.SqlClient, connections: Connections) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.acquireRelease(
      Effect.sync(() => {
        connections.opened += 1;

        return sql;
      }),
      () =>
        Effect.sync(() => {
          connections.closed += 1;
        }),
    ),
  );

const recordSpans = () => {
  const names: Array<string> = [];

  const tracer = Tracer.make({
    span: (options) => {
      names.push(options.name);

      return new Tracer.NativeSpan(options);
    },
  });

  return { names, tracer };
};

const requestsOver = <E extends Error>(connection: Layer.Layer<SqlClient.SqlClient, E>) =>
  Effect.provide(Effect.service(RecordingRequests), RecordingRequests.layerPerCall(connection));

describe("RecordingRequests.layerPerCall", () => {
  it.effect("opens a connection for each call and closes it afterwards", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;
      const connections: Connections = { opened: 0, closed: 0 };
      const requests = yield* requestsOver(countedConnection(sql, connections));

      assert.deepStrictEqual(connections, { opened: 0, closed: 0 });

      const submitted = yield* requests.submit(ada, "start");
      yield* requests.handlePending(emptyOffice);
      yield* requests.publishStatus({ recordingId: null, botInOffice: true, occupants: [] });

      const found = yield* requests.find(ada, submitted.id);
      const status = yield* requests.status;

      assert.strictEqual(submitted.outcome, null);
      assert.strictEqual(Option.getOrNull(found)?.outcome, "ignored");
      assert.isTrue(status.botInOffice);
      assert.deepStrictEqual(connections, { opened: 5, closed: 5 });
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("answers every method as unavailable when it can't connect", () =>
    Effect.gen(function* () {
      const requests = yield* requestsOver(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.fail(ConnectionRefused.make({ message: "Connection refused" })),
        ),
      );

      const failures = yield* Effect.all([
        requests.submit(ada, "start").pipe(Effect.flip),
        requests.find(ada, 1).pipe(Effect.flip),
        requests.status.pipe(Effect.flip),
        requests.handlePending(emptyOffice).pipe(Effect.flip),
        requests
          .publishStatus({ recordingId: null, botInOffice: false, occupants: [] })
          .pipe(Effect.flip),
      ]);

      for (const failure of failures) {
        assert.strictEqual(failure._tag, "RecordingUnavailable");
        assert.strictEqual(failure.reason, "Connection refused");
      }
    }),
  );
});

describe("RecordingRequests.handlePending", () => {
  it.effect("traces nothing while no request is waiting, and traces the requests it handles", () =>
    Effect.gen(function* () {
      yield* createTables;
      const requests = yield* RecordingRequests.make(Effect.void);
      const spans = recordSpans();

      yield* requests.handlePending(emptyOffice).pipe(Effect.withTracer(spans.tracer));

      assert.deepStrictEqual(spans.names, []);

      yield* requests.submit(ada, "start");
      yield* requests.handlePending(emptyOffice).pipe(Effect.withTracer(spans.tracer));

      assert.strictEqual(spans.names[0], "RecordingRequests.handlePending");
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("reports a request it can't read as an error, not as the database being down", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;
      const requests = yield* RecordingRequests.make(Effect.void);

      yield* sql`ALTER TABLE office.recording_requests DROP CONSTRAINT recording_requests_action_check`;
      yield* sql`
        INSERT INTO office.recording_requests (requested_by, requested_by_name, action)
        VALUES ('u1', 'Ada', 'dance')
      `;

      const failure = yield* requests.handlePending(emptyOffice).pipe(Effect.flip);

      assert.strictEqual(failure._tag, "RecordingUnavailable");
      assert.isTrue(failure.unreadable);
      assert.strictEqual(failure[ErrorReporter.severity], "Error");
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("reports a database it can't reach as a warning", () =>
    Effect.gen(function* () {
      const requests = yield* requestsOver(
        Layer.effect(
          SqlClient.SqlClient,
          Effect.fail(ConnectionRefused.make({ message: "Connection refused" })),
        ),
      );

      const failure = yield* requests.handlePending(emptyOffice).pipe(Effect.flip);

      assert.isFalse(failure.unreadable);
      assert.strictEqual(failure[ErrorReporter.severity], "Warn");
    }),
  );

  it.effect("gives up on a transaction that doesn't commit in time and rolls it back", () =>
    Effect.gen(function* () {
      const sql = yield* createTables;
      const stalled = yield* Deferred.make<void>();
      const committed = yield* Ref.make(false);

      const requests = RecordingRequests.makeWith(
        Effect.void,
        connectedTo(stallingBeforeCommit(sql, stalled)),
      );

      const submitted = yield* requests.submit(ada, "start");

      const fiber = yield* requests
        .handlePending(adaStarting(sql, committed))
        .pipe(Effect.forkChild);

      yield* Deferred.await(stalled);
      yield* TestClock.adjust(Duration.sum(QUERY_TIMEOUT, Duration.millis(1)));

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      const found = yield* requests.find(ada, submitted.id);

      assert.strictEqual(failure._tag, "RecordingUnavailable");
      assert.strictEqual(failure.reason, "Timed out after 10 seconds");
      assert.isFalse(failure.unreadable);
      assert.isFalse(yield* Ref.get(committed));
      assert.deepStrictEqual(yield* sql`SELECT id FROM office.recordings`, []);
      assert.strictEqual(Option.getOrNull(found)?.outcome, null);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );

  it.effect("passes the handler's own error through and leaves the request waiting", () =>
    Effect.gen(function* () {
      yield* createTables;
      const requests = yield* RecordingRequests.make(Effect.void);

      const broken: RequestHandler<CameraBroken, never> = {
        ...emptyOffice,
        situation: Effect.succeed({ occupants: new Set([ada.id]), active: Option.none() }),
        start: () => Effect.fail(CameraBroken.make()),
      };

      const submitted = yield* requests.submit(ada, "start");
      const failure = yield* requests.handlePending(broken).pipe(Effect.flip);
      const found = yield* requests.find(ada, submitted.id);

      assert.strictEqual(failure._tag, "CameraBroken");
      assert.strictEqual(Option.getOrNull(found)?.outcome, null);
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))),
  );
});
