import {
  DEFAULT_SUMMARY_STYLE,
  type HandledEdit,
  type Notice,
  type RecordingChange,
  SUMMARY_STYLE_LABELS,
  SUMMARY_STYLES,
  type SummaryStyle,
} from "./models";

export interface Draft {
  readonly title: string;
  readonly agenda: string;
  readonly summaryStyle: SummaryStyle;
}

export interface Plan {
  readonly title: string | null;
  readonly agenda: string | null;
  readonly summaryStyle: SummaryStyle;
}

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
