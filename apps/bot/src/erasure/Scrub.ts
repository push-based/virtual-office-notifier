import { Array, Option, Order, pipe, Predicate, Record, type Schema, String } from "effect";
import { FORMER_MEMBER } from "recording-requests/wire";

import { escapeSlackText } from "../slack/index.ts";

export const MIN_NAME_LENGTH = 3;

const DISPLAYED_KEYS: ReadonlySet<string> = new Set(["text", "alt_text"]);

export interface Scrubber {
  readonly needles: ReadonlyArray<string>;
  mentions(text: string): boolean;
  text(text: string): string;
  json(value: Schema.Json): Schema.Json;
  blocks(blocks: Schema.JsonArray): Schema.JsonArray;
  touches(value: Schema.Json): boolean;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapeRegExp = (text: string): string => pipe(text, String.replace(REGEXP_SPECIALS, "\\$&"));

const WORD = "[\\p{L}\\p{N}_]";

const longestFirst = Order.mapInput(Order.Number, (name: string) => -name.length);

const firstWordOf = (name: string): ReadonlyArray<string> =>
  Array.take(pipe(name, String.split(/\s+/)), 1);

const namesOf = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  pipe(
    names,
    Array.map(String.trim),
    Array.flatMap((name) => [name, ...firstWordOf(name)]),
    Array.filter((name) => name.length >= MIN_NAME_LENGTH && name !== FORMER_MEMBER),
    Array.flatMap((name) => [name, escapeSlackText(name)]),
    Array.dedupe,
    Array.sort(longestFirst),
  );

const patternOf = (
  names: ReadonlyArray<string>,
  slackUserIds: ReadonlyArray<string>,
): Option.Option<string> => {
  const alternatives = [
    ...Array.map(slackUserIds, (id) => `<@${escapeRegExp(id)}(?:\\|[^>]*)?>`),
    ...Array.map(names, (name) => `(?<!${WORD})${escapeRegExp(name)}(?!${WORD})`),
  ];

  return Array.isReadonlyArrayNonEmpty(alternatives)
    ? Option.some(Array.join(alternatives, "|"))
    : Option.none();
};

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

export const scrubberFor = (
  names: ReadonlyArray<string>,
  slackUserIds: ReadonlyArray<string>,
): Scrubber => {
  const kept = namesOf(names);
  const pattern = patternOf(kept, slackUserIds);

  const needles = pipe(
    [...kept, ...Array.map(slackUserIds, (id) => `<@${id}`)],
    Array.map(String.toLowerCase),
    Array.dedupe,
  );

  const matcher = Option.map(pattern, (source) => new RegExp(source, "u"));
  const replacer = Option.map(pattern, (source) => new RegExp(source, "gu"));

  const mentions = (text: string): boolean =>
    Option.exists(matcher, (expression) => expression.test(text));

  const text = (value: string): string =>
    Option.match(replacer, {
      onNone: () => value,
      onSome: (expression) => pipe(value, String.replace(expression, FORMER_MEMBER)),
    });

  const mentionedImage = (value: Schema.Json): boolean => {
    if (!isJsonObject(value) || value["type"] !== "image") return false;

    const alt = value["alt_text"];

    return Predicate.isString(alt) && mentions(alt);
  };

  const scrubIn =
    (scrubbed: (key: Option.Option<string>) => boolean) =>
    (value: Schema.Json, key: Option.Option<string>): Schema.Json => {
      if (Predicate.isString(value)) return scrubbed(key) ? text(value) : value;

      if (isJsonArray(value))
        return pipe(
          value,
          Array.filter((item) => !mentionedImage(item)),
          Array.map((item) => scrubIn(scrubbed)(item, Option.none())),
        );

      if (isJsonObject(value))
        return pipe(
          value,
          Record.filter((item) => !mentionedImage(item)),
          Record.map((item, name) => scrubIn(scrubbed)(item, Option.some(name))),
        );

      return value;
    };

  const displayed = (key: Option.Option<string>): boolean =>
    Option.exists(key, (name) => DISPLAYED_KEYS.has(name));

  const json = (value: Schema.Json): Schema.Json => scrubIn(() => true)(value, Option.none());

  const blocks = (values: Schema.JsonArray): Schema.JsonArray =>
    pipe(
      values,
      Array.filter((item) => !mentionedImage(item)),
      Array.map((item) => scrubIn(displayed)(item, Option.none())),
    );

  const touchesIn = (value: Schema.Json, key: Option.Option<string>): boolean => {
    if (Predicate.isString(value)) return displayed(key) && mentions(value);

    if (isJsonArray(value)) return Array.some(value, (item) => touchesIn(item, Option.none()));

    if (isJsonObject(value))
      return Array.some(Record.toEntries(value), ([name, item]) =>
        touchesIn(item, Option.some(name)),
      );

    return false;
  };

  const touches = (value: Schema.Json): boolean => touchesIn(value, Option.none());

  return { needles, mentions, text, json, blocks, touches };
};
