import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Array, DateTime, Duration, Effect, Option, Ref } from "effect";
import { SqlClient } from "effect/sql";

import { ADMINS } from "../src/Admins.ts";
import { NOT_AGREED, standingOf } from "../src/Consent.ts";
import {
  ConsentRequests,
  type ErasureHandler,
  type WithdrawalHandler,
} from "../src/ConsentRequests.ts";
import { columnNaming } from "../src/SqlNaming.ts";
import { CONSENT_NOTICE_VERSION, ERASURE_REVIEW_DAYS } from "../src/Wire.ts";
import { migrated } from "./schema.ts";

const CHRIS = ADMINS[0]!.discordUserId;

const decided = (
  userId: string,
  kind: "agreed" | "withdrawn",
  version = CONSENT_NOTICE_VERSION,
  at = "2026-11-06T09:00:00Z",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO office.consent_events (user_id, happened_at, kind, notice_version)
      VALUES (${userId}, ${at}, ${kind}, ${version})
    `;
  });

const member = (userId: string, displayName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO office.members (user_id, display_name, first_seen_at, last_seen_at)
      VALUES (${userId}, ${displayName}, now(), now())
      ON CONFLICT (user_id) DO NOTHING
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
  stillAgreed = false,
): ErasureHandler<never, SqlClient.SqlClient> => {
  const step = (text: string) => Ref.update(steps, (all) => [...all, text]);

  return {
    announce: ({ userId, inventory }) =>
      step(
        `announce ${userId} (${inventory.recordingRequests} requests, ${Array.join(inventory.names, "/")})`,
      ),
    settle: ({ userId }, outcome) => Effect.succeed({ afterCommit: step(`${outcome} ${userId}`) }),
    prepare: ({ userId }) => step(`prepare ${userId}`),
    erase: ({ userId }) =>
      Effect.gen(function* () {
        if (stillAgreed) return Option.none();

        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM office.members WHERE user_id = ${userId}`.pipe(Effect.orDie);
        yield* step(`erase ${userId}`);

        return Option.some({ afterCommit: step(`after ${userId}`) });
      }),
  };
};

const requestRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql<{
    readonly userId: string | null;
    readonly kind: string;
    readonly outcome: string | null;
    readonly decision: string | null;
  }>`
    SELECT user_id, kind, outcome, decision FROM office.consent_requests ORDER BY id
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

const makeDue = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`UPDATE office.consent_requests SET due_at = now() - interval '1 minute' WHERE id = ${id}`;
  });

const daysBetween = (from: DateTime.Utc, to: DateTime.Utc) =>
  Math.round(Duration.toMillis(DateTime.distance(from, to)) / (24 * 60 * 60 * 1000));

describe("ConsentRequests", () => {
  it.effect("says someone who was never asked hasn't agreed", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* requests.status("ada"), {
          standing: "not_agreed",
          since: null,
          pendingWithdrawal: null,
          pendingErasure: null,
          refusedErasure: null,
          admin: false,
        });
      }),
    ),
  );

  it.effect("says when someone agreed to the current notice, and who's an admin", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided(CHRIS, "agreed");

        const status = yield* requests.status(CHRIS);

        assert.strictEqual(status.standing, "agreed");
        assert.strictEqual(DateTime.formatIso(status.since!), "2026-11-06T09:00:00.000Z");
        assert.isTrue(status.admin);
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
        const first = yield* requests.withdraw("ada");
        const second = yield* requests.withdraw("ada");

        assert.deepStrictEqual(second, first);
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
        yield* decided("ada", "withdrawn", CONSENT_NOTICE_VERSION, "2026-11-06T10:00:00Z");
        yield* decided("ada", "agreed");

        assert.strictEqual((yield* requests.status("ada")).standing, "withdrawn");
      }),
    ),
  );
});

describe("ConsentRequests erasures", () => {
  it.effect("schedules the deletion a month out and keeps one request pending per person", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const first = yield* requests.erase("ada");
        const second = yield* requests.erase("ada");

        assert.deepStrictEqual(second, first);
        assert.strictEqual(first.outcome, null);
        const status = yield* requests.status("ada");

        assert.strictEqual(status.pendingErasure?.id, first.id);
        assert.strictEqual(
          daysBetween(status.pendingErasure!.requestedAt, status.pendingErasure!.dueAt),
          ERASURE_REVIEW_DAYS,
        );
        assert.deepStrictEqual(status.pendingErasure!.dueAt, first.dueAt);
        assert.strictEqual(status.pendingErasure?.decision, null);
        assert.isTrue(Option.isNone(yield* requests.findErasure("grace", first.id)));
      }),
    ),
  );

  it.effect("announces a new request once, with what it will delete, and waits", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* member("ada", "Ada Lovelace");
        yield* decided("ada", "agreed");
        yield* sql`
          INSERT INTO office.recording_requests (requested_by, requested_by_name, action)
          VALUES ('ada', 'Ada L.', 'start'), ('ada', 'Ada L.', 'stop')
        `;

        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));
        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (2 requests, Ada L./Ada Lovelace)",
        ]);
        assert.deepStrictEqual(
          yield* requests.findErasure("ada", id),
          Option.some({
            id,
            outcome: null,
            dueAt: (yield* requests.status("ada")).pendingErasure!.dueAt,
          }),
        );
        assert.strictEqual(yield* eventCount("ada"), 1);

        const cases = yield* requests.cases;

        assert.strictEqual(cases.length, 1);
        assert.strictEqual(cases[0]!.displayName, "Ada Lovelace");
        assert.strictEqual(cases[0]!.inventory.recordingRequests, 2);
        assert.deepStrictEqual(cases[0]!.inventory.names, ["Ada L.", "Ada Lovelace"]);
      }),
    ),
  );

  it.effect(
    "erases when the request is due: prepares, erases inside the transaction, then runs the handler",
    () =>
      withRequests((requests) =>
        Effect.gen(function* () {
          yield* member("ada", "Ada");
          yield* decided("ada", "agreed");
          yield* decided("grace", "agreed");
          yield* requests.withdraw("ada");

          const steps = yield* Ref.make<ReadonlyArray<string>>([]);
          const { id } = yield* requests.erase("ada");

          yield* makeDue(id);
          yield* requests.handleErasures(erasingHandler(steps));

          assert.deepStrictEqual(yield* Ref.get(steps), [
            "announce ada (0 requests, Ada)",
            "prepare ada",
            "erase ada",
            "after ada",
          ]);
          assert.strictEqual(
            Option.getOrThrow(yield* requests.findErasure("ada", id)).outcome,
            "erased",
          );
          assert.deepStrictEqual(yield* requestRows, [
            { userId: null, kind: "erase", outcome: "erased", decision: null },
          ]);
          assert.strictEqual(yield* eventCount("ada"), 0);
          assert.strictEqual(yield* eventCount("grace"), 1);
          assert.strictEqual((yield* requests.status("ada")).standing, "not_agreed");
          assert.deepStrictEqual(yield* requests.cases, []);
        }),
      ),
  );

  it.effect("erases straight away when an admin says so", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));

        assert.isTrue(Option.isNone(yield* requests.expedite(999, CHRIS)));

        const expedited = yield* requests.expedite(id, CHRIS);

        assert.strictEqual(Option.getOrThrow(expedited).outcome, null);
        assert.strictEqual((yield* requests.status("ada")).pendingErasure?.decision, "now");

        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (0 requests, )",
          "prepare ada",
          "erase ada",
          "after ada",
        ]);
        assert.isTrue(Option.isNone(yield* requests.expedite(id, CHRIS)));
      }),
    ),
  );

  it.effect("refuses on an admin's ground, keeps the row, and tells the person why", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* decided("ada", "agreed");

        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));

        const refused = yield* requests.refuse(id, CHRIS, {
          ground: "legal_claim",
          reason: "The recording of 3 November is evidence in a dispute with a supplier.",
        });

        assert.strictEqual(Option.getOrThrow(refused).outcome, null);
        assert.strictEqual((yield* requests.status("ada")).pendingErasure?.decision, "refused");

        yield* makeDue(id);
        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (0 requests, )",
          "refused ada",
        ]);

        const status = yield* requests.status("ada");

        assert.strictEqual(status.pendingErasure, null);
        assert.strictEqual(status.refusedErasure?.id, id);
        assert.strictEqual(status.refusedErasure?.ground, "legal_claim");
        assert.strictEqual(status.standing, "agreed");
        assert.strictEqual(yield* eventCount("ada"), 1);
        assert.isTrue(
          Option.isNone(
            yield* requests.refuse(id, CHRIS, { ground: "legal_claim", reason: "again" }),
          ),
        );
      }),
    ),
  );

  it.effect("lets the person cancel their own request, and nobody else's", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        assert.isTrue(Option.isNone(yield* requests.cancelErasure("grace", id)));
        assert.strictEqual(
          Option.getOrThrow(yield* requests.cancelErasure("ada", id)).outcome,
          null,
        );

        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (0 requests, )",
          "cancelled ada",
        ]);
        assert.deepStrictEqual(yield* requestRows, [
          { userId: "ada", kind: "erase", outcome: "cancelled", decision: "cancelled" },
        ]);
        assert.strictEqual((yield* requests.status("ada")).pendingErasure, null);
      }),
    ),
  );

  it.effect("cancels instead of erasing someone who agreed to being recorded since asking", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* requests.handleErasures(erasingHandler(steps));
        yield* decided("ada", "agreed", CONSENT_NOTICE_VERSION, "2099-01-01T00:00:00Z");
        yield* makeDue(id);
        yield* requests.handleErasures(erasingHandler(steps));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (0 requests, )",
          "cancelled ada",
        ]);
        assert.strictEqual(yield* eventCount("ada"), 1);
      }),
    ),
  );

  it.effect("cancels when the bot knows of an agreement the database hasn't seen", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const { id } = yield* requests.erase("ada");

        yield* makeDue(id);
        yield* requests.handleErasures(erasingHandler(steps, true));

        assert.deepStrictEqual(yield* Ref.get(steps), [
          "announce ada (0 requests, )",
          "prepare ada",
          "cancelled ada",
        ]);
        assert.deepStrictEqual(yield* requestRows, [
          { userId: "ada", kind: "erase", outcome: "cancelled", decision: "cancelled" },
        ]);
      }),
    ),
  );

  it.effect("cancels every pending request of someone who agrees again", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        yield* requests.erase("ada");
        yield* requests.cancelErasuresOf("ada");

        assert.strictEqual((yield* requests.status("ada")).pendingErasure?.decision, "cancelled");
      }),
    ),
  );

  it.effect("remembers which admins have seen a request, and the messages it sent them", () =>
    withRequests((requests) =>
      Effect.gen(function* () {
        const { id } = yield* requests.erase("ada");

        yield* requests.seen(id, CHRIS);
        yield* requests.seen(id, CHRIS);
        yield* requests.recordNotice({
          requestId: id,
          medium: "discord",
          recipient: CHRIS,
          channel: "dm1",
          messageId: "m1",
        });
        yield* requests.recordNotice({
          requestId: id,
          medium: "discord",
          recipient: CHRIS,
          channel: "dm1",
          messageId: "m2",
        });

        const [erasure] = yield* requests.cases;

        assert.deepStrictEqual(erasure!.seenBy, [CHRIS]);
        assert.deepStrictEqual(yield* requests.noticesOf(id), [
          { requestId: id, medium: "discord", recipient: CHRIS, channel: "dm1", messageId: "m2" },
        ]);
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

        yield* makeDue(id);
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

        yield* makeDue(id);

        const failed = yield* requests
          .handleErasures({
            announce: () => Effect.void,
            settle: () => Effect.succeed({ afterCommit: Effect.void }),
            prepare: () => Effect.void,
            erase: () => Effect.fail("bucket down" as const),
          })
          .pipe(Effect.flip);

        assert.strictEqual(failed, "bucket down");
        assert.strictEqual(Option.getOrThrow(yield* requests.findErasure("ada", id)).outcome, null);
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
