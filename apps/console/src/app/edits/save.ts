import { Effect, Option, Schema } from "effect";

import { ConsoleApi } from "../api/api.ts";
import { awaitAnswer } from "../api/answer.ts";
import { HandledEdit, type RecordingChange } from "office-domain/RecordingEdit";
import { editNotice } from "./plan.ts";

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
