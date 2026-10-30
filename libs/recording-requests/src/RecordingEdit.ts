import { Data, Schema } from "effect";

import { Agenda, type RecordingProgress, stateOf, Title } from "./Recording.ts";

export const EditKind = Schema.Literals(["title", "agenda", "tick", "untick", "reassign"]);

export type EditKind = typeof EditKind.Type;

export const TitleChange = Schema.Struct({ kind: Schema.Literal("title"), title: Title });

export const AgendaChange = Schema.Struct({ kind: Schema.Literal("agenda"), agenda: Agenda });

export const ActionItemId = Schema.Int.check(Schema.isGreaterThan(0));

export const TickChange = Schema.Struct({ kind: Schema.Literal("tick"), item: ActionItemId });

export const UntickChange = Schema.Struct({ kind: Schema.Literal("untick"), item: ActionItemId });

export const ReassignChange = Schema.Struct({
  kind: Schema.Literal("reassign"),
  item: ActionItemId,
  owner: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
});

export const RecordingChange = Schema.Union([
  TitleChange,
  AgendaChange,
  TickChange,
  UntickChange,
  ReassignChange,
]);

export type RecordingChange = typeof RecordingChange.Type;

export const EditOutcome = Schema.Literals(["applied", "ignored"]);

export type EditOutcome = typeof EditOutcome.Type;

export const EditIgnoreReason = Schema.Literals(["silent", "unreadable"]);

export type EditIgnoreReason = typeof EditIgnoreReason.Type;

export interface RecordingEdit {
  readonly id: number;
  readonly recordingId: string;
  readonly editedBy: string;
  readonly editedByName: string;
  readonly change: RecordingChange;
}

export type EditDecision = Data.TaggedEnum<{
  Apply: {};
  Ignore: { readonly reason: EditIgnoreReason };
}>;

export const EditDecision = Data.taggedEnum<EditDecision>();

export const decideEdit = (recording: RecordingProgress): EditDecision =>
  stateOf(recording) === "silent"
    ? EditDecision.Ignore({ reason: "silent" })
    : EditDecision.Apply();

export const explainEdit = (reason: EditIgnoreReason): string => {
  switch (reason) {
    case "silent":
      return "Nobody spoke in that recording, so there's nothing to change.";
    case "unreadable":
      return "The bot couldn't read that change.";
  }
};

export const PendingEdit = Schema.Struct({ id: Schema.Finite, outcome: Schema.Null });

export const AppliedEdit = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.Literal("applied"),
});

export const IgnoredEdit = Schema.Struct({
  id: Schema.Finite,
  outcome: Schema.Literal("ignored"),
  reason: EditIgnoreReason,
  explanation: Schema.String,
});

export const SubmittedEdit = Schema.Union([PendingEdit, AppliedEdit, IgnoredEdit]);

export type SubmittedEdit = typeof SubmittedEdit.Type;
