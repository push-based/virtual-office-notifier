import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, pipe, Schema, String } from "effect";

import { Agenda, Title } from "../src/Recording.ts";
import {
  decideEdit,
  EditDecision,
  explainEdit,
  RecordingChange,
  rewritesSummary,
} from "../src/RecordingEdit.ts";
import { SUMMARY_STYLES } from "../src/Wire.ts";
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
        Exit.isFailure(yield* Effect.exit(decodeChange({ kind: "action_items", items: [] }))),
      );
    }),
  );

  it.effect("is a change of summary style to one of the three styles, or Rewrite summary", () =>
    Effect.gen(function* () {
      for (const style of SUMMARY_STYLES) {
        assert.deepStrictEqual(yield* decodeChange({ kind: "summary_style", style }), {
          kind: "summary_style",
          style,
        });
      }

      assert.deepStrictEqual(yield* decodeChange({ kind: "rewrite_summary" }), {
        kind: "rewrite_summary",
      });
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(decodeChange({ kind: "summary_style", style: "long" }))),
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(decodeChange({ kind: "summary_style", style: null }))),
      );
    }),
  );
});

describe("RecordingChange for action items", () => {
  it.effect("ticks or unticks one action item, or gives it to someone or nobody", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeChange({ kind: "tick", item: 3 }), {
        kind: "tick",
        item: 3,
      });
      assert.deepStrictEqual(yield* decodeChange({ kind: "untick", item: 3 }), {
        kind: "untick",
        item: 3,
      });
      assert.deepStrictEqual(yield* decodeChange({ kind: "reassign", item: 3, owner: "u2" }), {
        kind: "reassign",
        item: 3,
        owner: "u2",
      });
      assert.deepStrictEqual(yield* decodeChange({ kind: "reassign", item: 3, owner: null }), {
        kind: "reassign",
        item: 3,
        owner: null,
      });
    }),
  );

  it.effect("can't reword or delete an item, and needs a real item and owner", () =>
    Effect.gen(function* () {
      const refused = [
        { kind: "tick", item: 0 },
        { kind: "tick", item: 1.5 },
        { kind: "tick", item: "3" },
        { kind: "reassign", item: 3 },
        { kind: "reassign", item: 3, owner: "" },
        { kind: "reword", item: 3, text: "book a bigger room" },
        { kind: "delete", item: 3 },
      ];

      for (const change of refused)
        assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeChange(change))));
    }),
  );
});

const running = { stopped: false, finished: false, posted: false };

const transcribing = { stopped: true, finished: false, posted: false };

const finished = { stopped: true, finished: true, posted: true };

const silent = { stopped: true, finished: true, posted: false };

const retitle: RecordingChange = { kind: "title", title: "Retro" };

const restyle: RecordingChange = { kind: "summary_style", style: "detailed" };

const rewrite: RecordingChange = { kind: "rewrite_summary" };

describe("decideEdit", () => {
  it("applies an edit to a running, transcribing or finished recording", () => {
    for (const recording of [running, transcribing, finished]) {
      assert.deepStrictEqual(decideEdit(recording, retitle), EditDecision.Apply());
      assert.deepStrictEqual(decideEdit(recording, restyle), EditDecision.Apply());
    }
  });

  it("ignores an edit to a silent recording", () => {
    for (const change of [retitle, restyle, rewrite]) {
      assert.deepStrictEqual(decideEdit(silent, change), EditDecision.Ignore({ reason: "silent" }));
    }
  });

  it("rewrites the summary of a finished recording only, since the others have none yet", () => {
    assert.deepStrictEqual(decideEdit(finished, rewrite), EditDecision.Apply());
    assert.deepStrictEqual(
      decideEdit(running, rewrite),
      EditDecision.Ignore({ reason: "unfinished" }),
    );
    assert.deepStrictEqual(
      decideEdit(transcribing, rewrite),
      EditDecision.Ignore({ reason: "unfinished" }),
    );
  });

  it("explains every reason it ignores an edit", () => {
    assert.include(explainEdit("silent"), "Nobody spoke");
    assert.include(explainEdit("unreadable"), "couldn't read");
    assert.include(explainEdit("unfinished"), "nothing to rewrite");
  });
});

describe("rewritesSummary", () => {
  it("is true for a change of summary style or agenda, and for Rewrite summary", () => {
    assert.isTrue(rewritesSummary(restyle));
    assert.isTrue(rewritesSummary({ kind: "agenda", agenda: "Friday" }));
    assert.isTrue(rewritesSummary(rewrite));
    assert.isFalse(rewritesSummary(retitle));
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

  it("send an action item by its ID, and a new owner as a user ID or null", () => {
    expectTypeOf<Wire.TickChange>().toEqualTypeOf<{
      readonly kind: "tick";
      readonly item: number;
    }>();
    expectTypeOf<Wire.UntickChange>().toEqualTypeOf<{
      readonly kind: "untick";
      readonly item: number;
    }>();
    expectTypeOf<Wire.ReassignChange>().toEqualTypeOf<{
      readonly kind: "reassign";
      readonly item: number;
      readonly owner: string | null;
    }>();
  });

  it("send a summary style by name, and Rewrite summary with nothing else", () => {
    expectTypeOf<Wire.SummaryStyle>().toEqualTypeOf<"brief" | "detailed" | "decisions">();
    expectTypeOf<Wire.SummaryStyleChange>().toEqualTypeOf<{
      readonly kind: "summary_style";
      readonly style: Wire.SummaryStyle;
    }>();
    expectTypeOf<Wire.RewriteSummaryChange>().toEqualTypeOf<{
      readonly kind: "rewrite_summary";
    }>();
    expectTypeOf<Wire.RequestSubmission["summaryStyle"]>().toEqualTypeOf<
      Wire.SummaryStyle | undefined
    >();
  });
});
