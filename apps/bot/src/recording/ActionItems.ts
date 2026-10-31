import {
  Array,
  Data,
  ErrorReporter,
  identity,
  type LogLevel,
  Option,
  pipe,
  Schema,
  SchemaTransformation,
  String,
} from "effect";

export const MAX_ACTION_ITEMS = 10;

export const MAX_ACTION_ITEM_LENGTH = 150;

export interface Member {
  readonly userId: string;
  readonly name: string;
}

export interface PulledItem {
  readonly text: string;
  readonly ownerName: string | null;
}

export interface OwnedItem {
  readonly text: string;
  readonly owner: string | null;
}

export interface PulledActionItems {
  readonly model: string;
  readonly items: ReadonlyArray<OwnedItem>;
}

export interface ActionItemLine {
  readonly id: number;
  readonly text: string;
  readonly ownerName: string | null;
  readonly done: boolean;
}

export type ActionItemList = Data.TaggedEnum<{
  NotTried: {};
  Failed: {};
  Pulled: { readonly items: ReadonlyArray<ActionItemLine> };
}>;

export const ActionItemList = Data.taggedEnum<ActionItemList>();

const ItemText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ACTION_ITEM_LENGTH)),
    SchemaTransformation.transform({
      decode: (text) => pipe(text, String.replace(/\s+/g, " "), String.trim),
      encode: identity,
    }),
  ),
);

const ReplyItem = Schema.Struct({
  text: ItemText,
  owner: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ActionItemsReply = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (text) =>
        pipe(
          text,
          String.trim,
          String.replace(/^```(?:json)?\s*/i, ""),
          String.replace(/\s*```$/, ""),
        ),
      encode: identity,
    }),
  ),
  Schema.decodeTo(
    Schema.fromJsonString(Schema.Array(ReplyItem).check(Schema.isMaxLength(MAX_ACTION_ITEMS))),
  ),
);

export class NoAiActionItems extends Schema.TaggedError<
  NoAiActionItems,
  { readonly brand: unique symbol }
>()("NoAiActionItems", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `No AI model could pull out the recording's action items, the last failed with ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

export const ACTION_ITEMS_PROMPT = Array.join(
  [
    "You pull the action items out of a recorded conversation from a team's virtual office, a Discord voice channel where people work alongside each other. The transcript was made by speech recognition, one line per stretch of speech, each with the time in UTC+2 and who spoke.",
    "An action item is a piece of follow-up work someone took on, or was asked to do, during the conversation. Leave out anything that was only talked about, and anything already done before the conversation ended.",
    "The request starts with the people who were in the office, one name per line. Each action item has an owner: whoever took it on, written exactly as in that list, or null when nobody took it on or you can't tell who did.",
    "The request can include the recording's title and agenda. The agenda is what people meant to cover, not what happened: only list work the transcript shows someone took on.",
    "A line like '14:20–14:35 Paused by Ben' marks a pause: nothing was recorded in that stretch, so don't guess what was said during it.",
    "Write each action item as a short instruction starting with a verb in lower case, like 'write up the deploy checklist', under 100 characters, without the owner's name.",
    `Reply with JSON only, no markdown and no code fences: an array like [{"text": "write up the deploy checklist", "owner": "Anna"}, {"text": "ask IT about the VPN", "owner": null}], or [] when there are none. List at most ${MAX_ACTION_ITEMS}, the most important first.`,
  ],
  "\n",
);

export const actionItemsRequest = (members: ReadonlyArray<Member>, request: string): string =>
  Array.join(
    ["People in the office:", ...Array.map(members, ({ name }) => name), "", request],
    "\n",
  );

const normalized = (name: string): string =>
  pipe(
    name,
    String.trim,
    String.replace(/^@/, ""),
    String.replace(/\s+/g, " "),
    String.toLowerCase,
  );

const firstWord = (name: string): string =>
  pipe(normalized(name), String.split(" "), Array.headNonEmpty);

const onlyOne = (matches: ReadonlyArray<Member>): Option.Option<string> =>
  matches.length === 1 ? Option.map(Array.head(matches), ({ userId }) => userId) : Option.none();

export const ownerOf = (members: ReadonlyArray<Member>, name: string | null): string | null => {
  if (name === null) return null;

  const wanted = normalized(name);

  return pipe(
    onlyOne(Array.filter(members, (member) => normalized(member.name) === wanted)),
    Option.orElse(() =>
      onlyOne(Array.filter(members, (member) => firstWord(member.name) === wanted)),
    ),
    Option.getOrNull,
  );
};

export const ownedBy = (
  members: ReadonlyArray<Member>,
  items: ReadonlyArray<PulledItem>,
): ReadonlyArray<OwnedItem> =>
  Array.map(items, ({ text, ownerName }) => ({ text, owner: ownerOf(members, ownerName) }));
