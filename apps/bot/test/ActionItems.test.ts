import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Exit, pipe, Schema, String } from "effect";

import {
  actionItemsRequest,
  ActionItemsReply,
  MAX_ACTION_ITEM_LENGTH,
  MAX_ACTION_ITEMS,
  type Member,
  ownedBy,
  ownerOf,
} from "../src/ActionItems.ts";

const decode = Schema.decodeUnknownEffect(ActionItemsReply);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const anna: Member = { userId: "u1", name: "Anna Schmidt" };

const ben: Member = { userId: "u2", name: "Ben" };

const benjamin: Member = { userId: "u3", name: "Ben Okafor" };

describe("ActionItemsReply", () => {
  it.effect("reads a JSON list of what needs doing and who owns it, tidying up the text", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* decode(
          '[{"text": "  write up the\\n deploy checklist ", "owner": "Anna"}, {"text": "ask IT about the VPN", "owner": null}]',
        ),
        [
          { text: "write up the deploy checklist", owner: "Anna" },
          { text: "ask IT about the VPN", owner: null },
        ],
      );
    }),
  );

  it.effect("takes a list wrapped in a code fence, an empty list and a missing owner", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decode('```json\n[{"text": "book the room"}]\n```'), [
        { text: "book the room" },
      ]);
      assert.deepStrictEqual(yield* decode("[]"), []);
    }),
  );

  it.effect("refuses anything that isn't the list, too many items or items that are too long", () =>
    Effect.gen(function* () {
      const item = { text: "book the room", owner: null };

      const refused = [
        "Here are the action items: none",
        '{"text": "book the room", "owner": null}',
        '[{"text": "   ", "owner": null}]',
        '[{"owner": "Anna"}]',
        yield* encodeJson(Array.replicate(item, MAX_ACTION_ITEMS + 1)),
        yield* encodeJson([
          { text: pipe("x", String.repeat(MAX_ACTION_ITEM_LENGTH + 1)), owner: null },
        ]),
      ];

      for (const reply of refused) assert.isTrue(Exit.isFailure(yield* Effect.exit(decode(reply))));

      const most = yield* encodeJson(Array.replicate(item, MAX_ACTION_ITEMS));
      assert.lengthOf(yield* decode(most), MAX_ACTION_ITEMS);
    }),
  );
});

describe("ownerOf", () => {
  const office = [anna, ben, benjamin];

  it("matches the name the model gave to one person in the office, ignoring case and spacing", () => {
    assert.strictEqual(ownerOf(office, " anna  schmidt "), "u1");
    assert.strictEqual(ownerOf(office, "@Ben"), "u2");
  });

  it("matches a first name when only one person in the office has it", () => {
    assert.strictEqual(ownerOf(office, "Anna"), "u1");
    assert.strictEqual(ownerOf([anna, benjamin], "Ben"), "u3");
  });

  it("leaves an item unassigned when nobody owns it, the name matches nobody or more than one", () => {
    assert.isNull(ownerOf(office, null));
    assert.isNull(ownerOf(office, "Carla"));
    assert.isNull(ownerOf(office, ""));
    assert.isNull(ownerOf([anna, { userId: "u4", name: "Anna Weber" }], "Anna"));
  });

  it("gives every pulled item its owner's user ID", () => {
    assert.deepStrictEqual(
      ownedBy(office, [
        { text: "write up the deploy checklist", ownerName: "Anna" },
        { text: "ask IT about the VPN", ownerName: "Carla" },
      ]),
      [
        { text: "write up the deploy checklist", owner: "u1" },
        { text: "ask IT about the VPN", owner: null },
      ],
    );
  });
});

describe("actionItemsRequest", () => {
  it("names the people in the office above the recording", () => {
    assert.strictEqual(
      actionItemsRequest([anna, ben], "Transcript:\n10:01 Ben: Hello"),
      "People in the office:\nAnna Schmidt\nBen\n\nTranscript:\n10:01 Ben: Hello",
    );
  });
});
