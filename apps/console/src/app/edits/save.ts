import { Effect, Option, Schema } from "effect";

import * as Api from "../api/api.ts";
import { awaitAnswer, REQUEST_ANSWER } from "../api/answer.ts";
import { HandledEdit, type RecordingChange, SubmittedEdit } from "../wire.ts";
import { editNotice } from "./plan.ts";

const isHandled = Schema.is(HandledEdit);

const submitted = (recordingId: string, change: RecordingChange) =>
  Api.post(`/api/recordings/${encodeURIComponent(recordingId)}/edits`, SubmittedEdit, change).pipe(
    Effect.flatMap(({ id }) =>
      awaitAnswer(Api.get(`/api/edits/${id}`, SubmittedEdit), isHandled, REQUEST_ANSWER),
    ),
    Effect.map(Option.getOrNull),
  );

export const saveChanges = (recordingId: string, changes: ReadonlyArray<RecordingChange>) =>
  Effect.forEach(changes, (change) => submitted(recordingId, change)).pipe(
    Effect.map((results) => Option.fromNullishOr(editNotice(results))),
  );
