import { Schema } from "effect";

import type { Notice } from "../notice.ts";
import { SummaryStyle } from "office-domain/Recording";
import type { HandledEdit, RecordingChange } from "office-domain/RecordingEdit";
import { DEFAULT_SUMMARY_STYLE, SUMMARY_STYLE_LABELS, SUMMARY_STYLES } from "office-domain/wire";

export const Draft = Schema.Struct({
  title: Schema.String,
  agenda: Schema.String,
  summaryStyle: SummaryStyle,
});

export type Draft = typeof Draft.Type;

export const Plan = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  agenda: Schema.NullOr(Schema.String),
  summaryStyle: SummaryStyle,
});

export type Plan = typeof Plan.Type;

export const EMPTY_DRAFT: Draft = { title: "", agenda: "", summaryStyle: DEFAULT_SUMMARY_STYLE };

export const STYLE_OPTIONS = SUMMARY_STYLES.map((style) => ({
  value: style,
  label: SUMMARY_STYLE_LABELS[style],
}));

export const summaryStyleOf = (value: string): SummaryStyle =>
  SUMMARY_STYLES.find((style) => style === value) ?? DEFAULT_SUMMARY_STYLE;

export const draftOf = (plan: Plan): Draft => ({
  title: plan.title ?? "",
  agenda: plan.agenda ?? "",
  summaryStyle: plan.summaryStyle,
});

const orNull = (text: string): string | null => (text === "" ? null : text);

export const planOf = (draft: Draft): Plan => ({
  title: orNull(draft.title.replace(/\s+/g, " ").trim()),
  agenda: orNull(draft.agenda.trim()),
  summaryStyle: draft.summaryStyle,
});

export const changesBetween = (current: Plan, draft: Draft): ReadonlyArray<RecordingChange> => {
  const next = planOf(draft);

  return [
    ...(next.title === current.title ? [] : [{ kind: "title" as const, title: next.title }]),
    ...(next.agenda === current.agenda ? [] : [{ kind: "agenda" as const, agenda: next.agenda }]),
    ...(next.summaryStyle === current.summaryStyle
      ? []
      : [{ kind: "summary_style" as const, style: next.summaryStyle }]),
  ];
};

export const editNotice = (results: ReadonlyArray<HandledEdit | null>): Notice | null => {
  for (const result of results) {
    if (result?.outcome === "ignored") return { kind: "error", text: result.explanation };
  }

  return results.includes(null)
    ? { kind: "error", text: "The bot hasn't saved that yet. It will once it's back." }
    : null;
};
