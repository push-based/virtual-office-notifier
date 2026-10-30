import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, pipe, Schema, String } from "effect";

import { Agenda, Title } from "../src/Recording.ts";
import { decideEdit, EditDecision, explainEdit, RecordingChange } from "../src/RecordingEdit.ts";
import type * as Wire from "../src/Wire.ts";

const xs = (count: number) => pipe("x", String.repeat(count));

const decodeTitle = Schema.decodeUnknownEffect(Title);

const decodeAgenda = Schema.decodeUnknownEffect(Agenda);

const decodeChange = Schema.decodeUnknownEffect(RecordingChange);

describe("Title", () => {
  it.effect("trims, folds spaces and line breaks into one, and treats blank as none", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeTitle("  Deploy \n\t retro  "), "Deploy retro");
      assert.isNull(yield* decodeTitle("   "));
      assert.isNull(yield* decodeTitle(null));
    }),
  );

  it.effect("allows up to 80 characters", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeTitle(`  ${xs(80)}  `), xs(80));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeTitle(xs(81)))));
    }),
  );
});

describe("Agenda", () => {
  it.effect("trims, keeps line breaks inside, and treats blank as none", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* decodeAgenda("\n• What broke\n• Who fixes it\n"),
        "• What broke\n• Who fixes it",
      );
      assert.isNull(yield* decodeAgenda(" \n "));
    }),
  );

  it.effect("allows up to 500 characters", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeAgenda(xs(500)), xs(500));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeAgenda(xs(501)))));
    }),
  );
});

describe("RecordingChange", () => {
  it.effect("is a change to the title or to the agenda, one at a time", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeChange({ kind: "title", title: " Retro " }), {
        kind: "title",
        title: "Retro",
      });
      assert.deepStrictEqual(yield* decodeChange({ kind: "agenda", agenda: null }), {
        kind: "agenda",
        agenda: null,
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeChange({ kind: "title" }))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(decodeChange({ kind: "summary_style", style: "brief" }))),
      );
    }),
  );
});

describe("decideEdit", () => {
  it("applies an edit to a running, transcribing or finished recording", () => {
    assert.deepStrictEqual(
      decideEdit({ stopped: false, finished: false, posted: false }),
      EditDecision.Apply(),
    );
    assert.deepStrictEqual(
      decideEdit({ stopped: true, finished: false, posted: false }),
      EditDecision.Apply(),
    );
    assert.deepStrictEqual(
      decideEdit({ stopped: true, finished: true, posted: true }),
      EditDecision.Apply(),
    );
  });

  it("ignores an edit to a silent recording", () => {
    assert.deepStrictEqual(
      decideEdit({ stopped: true, finished: true, posted: false }),
      EditDecision.Ignore({ reason: "silent" }),
    );
  });

  it("explains every reason it ignores an edit", () => {
    assert.include(explainEdit("silent"), "Nobody spoke");
    assert.include(explainEdit("unreadable"), "couldn't read");
  });
});

describe("the page's edit types", () => {
  it("send a title or agenda as text, or null to clear it", () => {
    expectTypeOf<Wire.TitleChange>().toEqualTypeOf<{
      readonly kind: "title";
      readonly title: string | null;
    }>();
    expectTypeOf<Wire.AgendaChange>().toEqualTypeOf<{
      readonly kind: "agenda";
      readonly agenda: string | null;
    }>();
    expectTypeOf<Wire.RequestSubmission["title"]>().toEqualTypeOf<string | null | undefined>();
  });
});
