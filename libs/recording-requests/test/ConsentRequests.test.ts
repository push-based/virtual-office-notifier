import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { NOT_AGREED, standingOf } from "../src/Consent.ts";
import { ConsentRequests, type WithdrawalHandler } from "../src/ConsentRequests.ts";
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
): WithdrawalHandler<never, never> => ({
  withdraw: ({ userId }) =>
    Effect.succeed({ afterCommit: Ref.update(withdrawn, (all) => [...all, userId]) }),
});

describe("ConsentRequests", () => {
  it.effect("says someone who was never asked hasn't agreed", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* requests.status("ada"), {
          standing: "not_agreed",
          since: null,
          pendingWithdrawal: null,
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

        yield* requests.handlePending(recordingHandler(withdrawn));

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

        yield* requests.handlePending(recordingHandler(withdrawn));

        assert.deepStrictEqual(yield* Ref.get(withdrawn), []);
        assert.deepStrictEqual(
          yield* requests.find("ada", id),
          Option.some({ id, outcome: "ignored" }),
        );
        assert.strictEqual((yield* requests.status("ada")).standing, "not_agreed");
      }),
    ),
  );
});

describe("standingOf", () => {
  it("is not agreed without a decision", () => {
    assert.deepStrictEqual(standingOf(Option.none()), NOT_AGREED);
  });
});
