import { Effect, Option, Predicate, Schema } from "effect";
import { NoticeContent } from "design-system";
import { defineTaggedUnion } from "foldkit/schema";

import { ConsoleApi } from "../api/api.ts";
import { awaitAnswer } from "../api/answer.ts";
import { unreachableNotice } from "../recorder/notices.ts";
import { HandledEdit, type RecordingChange } from "office-domain/RecordingEdit";
import { editNotice } from "./plan.ts";

export const SaveState = defineTaggedUnion({
  Idle: {},
  Saving: {},
  Answered: { notice: NoticeContent },
});

export type SaveState = typeof SaveState.Type;

export const isSaving = (state: SaveState): boolean => Predicate.isTagged(state, "Saving");

export const noticeOf = (state: SaveState): Option.Option<NoticeContent> =>
  SaveState.match<Option.Option<NoticeContent>>(state, {
    Idle: () => Option.none(),
    Saving: () => Option.none(),
    Answered: ({ notice }) => Option.some(notice),
  });

export const answered = (maybeNotice: Option.Option<NoticeContent>): SaveState =>
  Option.match(maybeNotice, {
    onNone: () => SaveState.Idle(),
    onSome: (notice) => SaveState.Answered({ notice }),
  });

export const failedSave = (reason: string): SaveState =>
  SaveState.Answered({ notice: unreachableNotice(reason) });

const isHandled = Schema.is(HandledEdit);

const submitted = (recordingId: string, change: RecordingChange) =>
  ConsoleApi.use((api) =>
    api.edits
      .submit({ params: { id: recordingId }, payload: change })
      .pipe(Effect.flatMap(({ id }) => awaitAnswer(api.edits.find({ params: { id } }), isHandled))),
  ).pipe(Effect.map(Option.getOrNull));

export const saveChanges = (recordingId: string, changes: ReadonlyArray<RecordingChange>) =>
  Effect.forEach(changes, (change) => submitted(recordingId, change)).pipe(
    Effect.map((results) => Option.fromNullishOr(editNotice(results))),
  );
