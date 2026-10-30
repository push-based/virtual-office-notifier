import type { HandledEdit, Notice, RecordingChange } from "./models";

export interface Draft {
  readonly title: string;
  readonly agenda: string;
}

export interface Plan {
  readonly title: string | null;
  readonly agenda: string | null;
}

export const EMPTY_DRAFT: Draft = { title: "", agenda: "" };

export const draftOf = (plan: Plan): Draft => ({
  title: plan.title ?? "",
  agenda: plan.agenda ?? "",
});

const orNull = (text: string): string | null => (text === "" ? null : text);

export const planOf = (draft: Draft): Plan => ({
  title: orNull(draft.title.replace(/\s+/g, " ").trim()),
  agenda: orNull(draft.agenda.trim()),
});

export const changesBetween = (current: Plan, draft: Draft): ReadonlyArray<RecordingChange> => {
  const next = planOf(draft);

  return [
    ...(next.title === current.title ? [] : [{ kind: "title" as const, title: next.title }]),
    ...(next.agenda === current.agenda ? [] : [{ kind: "agenda" as const, agenda: next.agenda }]),
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
