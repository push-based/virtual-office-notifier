import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Effect, ErrorReporter, Layer, Option, Schema, Tracer } from "effect";
import { SqlClient } from "effect/sql";

import { RecordingRequests, type RequestHandler } from "../src/RecordingRequests.ts";
import { columnNaming } from "../src/SqlNaming.ts";

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

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE SCHEMA office`;
  yield* sql`
    CREATE TABLE office.members (user_id text PRIMARY KEY, display_name text NOT NULL, real_name text)
  `;
  yield* sql`
    CREATE TABLE office.recordings (
      id uuid PRIMARY KEY, started_at timestamptz NOT NULL, started_by text NOT NULL, stopped_at timestamptz,
      paused_at timestamptz, paused_by text, title text, agenda text,
      summary_style text NOT NULL DEFAULT 'brief'
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_requests (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      requested_at timestamptz NOT NULL DEFAULT now(),
      requested_by text NOT NULL,
      requested_by_name text NOT NULL,
      action text NOT NULL,
      handled_at timestamptz,
      outcome text,
      reason text,
      recording_id uuid,
      title text,
      agenda text,
      summary_style text
    )
  `;
  yield* sql`
    CREATE TABLE office.recording_status (
      recording_id uuid,
      bot_in_office boolean NOT NULL DEFAULT false,
      occupants jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  yield* sql`INSERT INTO office.recording_status DEFAULT VALUES`;

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
});
