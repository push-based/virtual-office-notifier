import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { NOT_AGREED, standingOf } from "../src/Consent.ts";
import {
  ConsentRequests,
  type ErasureHandler,
  type WithdrawalHandler,
} from "../src/ConsentRequests.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import { CONSENT_NOTICE_VERSION } from "../src/Wire.ts";
import { migrated } from "./schema.ts";

const decided = (userId: string, kind: "agreed" | "withdrawn", version = CONSENT_NOTICE_VERSION) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version)
      VALUES (${userId}, '2026-11-06T09:00:00Z', ${kind}, ${version})
    `;
  });

const withRequests = <A, E>(
  use: (requests: ConsentRequests["Service"]) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* migrated;

    return yield* use(yield* ConsentRequests.make(Effect.void));
  }).pipe(Effect.provide(PgliteClient.layer(columnNaming)));

const recordingHandler = (
  withdrawn: Ref.Ref<ReadonlyArray<string>>,
  knowsBetter = false,
): WithdrawalHandler<never, never> => ({
  withdraw: ({ userId }, recorded) =>
    Effect.succeed(
      recorded === "agreed" || knowsBetter
        ? Option.some({ afterCommit: Ref.update(withdrawn, (all) => [...all, userId]) })
        : Option.none(),
    ),
});

const erasingHandler = (
  steps: Ref.Ref<ReadonlyArray<string>>,
): ErasureHandler<never, SqlClient.SqlClient> => ({
  prepare: ({ userId }) => Ref.update(steps, (all) => [...all, `prepare ${userId}`]),
  erase: ({ userId }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM office.members WHERE user_id = ${userId}`.pipe(Effect.orDie);
      yield* Ref.update(steps, (all) => [...all, `erase ${userId}`]);

      return { afterCommit: Ref.update(steps, (all) => [...all, `after ${userId}`]) };
    }),
});

const requestRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{
    readonly userId: string | null;
    readonly kind: string;
    readonly outcome: string | null;
  }>`
    SELECT user_id, kind, outcome FROM office.consent_requests ORDER BY id
  `;
});

const eventCount = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<{ readonly total: number }>`
      SELECT count(*)::int AS total FROM office.consent_events WHERE user_id = ${userId}
    `;

    return rows[0]?.total ?? 0;
  });

describe("ConsentRequests", () => {
  it.effect("says someone who was never asked hasn't agreed", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* requests.status("ada"), {
          standing: "not_agreed",
          since: null,
          pendingWithdrawal: null,
          pendingErasure: null,
        });
      }),
    ),
  );

  it.effect("says when someone agreed to the current notice", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const status = yield* requests.status("ada");

        assert.strictEqual(status.standing, "agreed");
        assert.strictEqual(status.since?.pipe(DateTime.formatIso), "2026-11-06T09:00:00.000Z");
      }),
    ),
  );

  it.effect("doesn't count agreeing to an older notice", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed", CONSENT_NOTICE_VERSION - 1);

        assert.strictEqual((yield* requests.status("ada")).standing, "not_agreed");
      }),
    ),
  );

  it.effect("keeps one withdrawal pending per person", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const first = yield* requests.withdraw("ada");
        const second = yield* requests.withdraw("ada");

        assert.deepStrictEqual(second, first);
        assert.strictEqual(first.outcome, null);
        assert.strictEqual((yield* requests.status("ada")).pendingWithdrawal, first.id);
        assert.isTrue(Option.isNone(yield* requests.find("grace", first.id)));
      }),
    ),
  );

  it.effect("withdraws consent, records it, and runs the handler after committing", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const withdrawn = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.withdraw("ada");

        yield* requests.handleWithdrawals(recordingHandler(withdrawn));

        const status = yield* requests.status("ada");

        assert.deepStrictEqual(yield* Ref.get(withdrawn), ["ada"]);
        assert.strictEqual(status.standing, "withdrawn");
        assert.strictEqual(status.pendingWithdrawal, null);
        assert.deepStrictEqual(
          yield* requests.find("ada", id),
          Option.some({ id, outcome: "withdrawn" }),
        );
      }),
    ),
  );

  it.effect("ignores a withdrawal when there's nothing to withdraw", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const withdrawn = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.withdraw("ada");

        yield* requests.handleWithdrawals(recordingHandler(withdrawn));

        assert.deepStrictEqual(yield* Ref.get(withdrawn), []);
        assert.deepStrictEqual(
          yield* requests.find("ada", id),
          Option.some({ id, outcome: "ignored" }),
        );
        assert.strictEqual((yield* requests.status("ada")).standing, "not_agreed");
      }),
    ),
  );

  it.effect("withdraws when the handler knows of an agreement the database hasn't seen", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const withdrawn = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.withdraw("ada");

        yield* requests.handleWithdrawals(recordingHandler(withdrawn, true));

        assert.deepStrictEqual(yield* Ref.get(withdrawn), ["ada"]);
        assert.deepStrictEqual(
          yield* requests.find("ada", id),
          Option.some({ id, outcome: "withdrawn" }),
        );
        assert.strictEqual((yield* requests.status("ada")).standing, "withdrawn");
      }),
    ),
  );

  it.effect("goes by when things happened, not by when they were written", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version)
          VALUES ('ada', '2026-11-06T10:00:00Z', 'withdrawn', ${CONSENT_NOTICE_VERSION})
        `;
        yield* decided("ada", "agreed");

        assert.strictEqual((yield* requests.status("ada")).standing, "withdrawn");
      }),
    ),
  );
});

describe("ConsentRequests erasures", () => {
  it.effect("keeps one erasure pending per person and shows it in the status", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const first = yield* requests.erase("ada");
        const second = yield* requests.erase("ada");

        assert.deepStrictEqual(second, first);
        assert.deepStrictEqual(first.outcome, null);
        assert.strictEqual((yield* requests.status("ada")).pendingErasure, first.id);
        assert.isTrue(Option.isNone(yield* requests.findErasure("grace", first.id)));
      }),
    ),
  );

  it.effect("prepares, erases inside the transaction, then runs the handler after committing", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");
        yield* decided("grace", "agreed");
        yield* requests.withdraw("ada");

        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), ["prepare ada", "erase ada", "after ada"]);
        assert.deepStrictEqual(
          yield* requests.findErasure("ada", id),
          Option.some({ id, outcome: "erased" }),
        );
        assert.deepStrictEqual(yield* requestRows, [
          { userId: null, kind: "erase", outcome: "erased" },
        ]);
        assert.strictEqual(yield* eventCount("ada"), 0);
        assert.strictEqual(yield* eventCount("grace"), 1);
        assert.deepStrictEqual(yield* requests.status("ada"), {
          standing: "not_agreed",
          since: null,
          pendingWithdrawal: null,
          pendingErasure: null,
        });
      }),
    ),
  );

  it.effect("stops answering for an erasure once the Console has had time to see it", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* decided("ada", "agreed");

        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));
        yield* sql`
          UPDATE office.consent_requests SET handled_at = now() - interval '1 hour' WHERE id = ${id}
        `;

        assert.isTrue(Option.isNone(yield* requests.findErasure("ada", id)));
      }),
    ),
  );

  it.effect("leaves the erasure pending when it fails", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const { id } = yield* requests.erase("ada");

        const failed = yield* requests
          .handleErasures({
            prepare: () => Effect.void,
            erase: () => Effect.fail("bucket down" as const),
          })
          .pipe(Effect.flip);

        assert.strictEqual(failed, "bucket down");
        assert.deepStrictEqual(
          yield* requests.findErasure("ada", id),
          Option.some({ id, outcome: null }),
        );
        assert.strictEqual(yield* eventCount("ada"), 1);
      }),
    ),
  );

  it.effect("doesn't touch withdrawals", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const { id } = yield* requests.withdraw("ada");
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);

        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), []);
        assert.deepStrictEqual(yield* requests.find("ada", id), Option.some({ id, outcome: null }));
      }),
    ),
  );
});

describe("standingOf", () => {
  it("is not agreed without a decision", () => {
    assert.deepStrictEqual(standingOf(Option.none()), NOT_AGREED);
  });
});
