import { DestroyRef, Service, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
  type Observable,
  catchError,
  concatMap,
  finalize,
  first,
  from,
  map,
  of,
  repeat,
  switchMap,
  timer,
  toArray,
} from "rxjs";

import { unreachableNotice } from "../recorder/notices";
import { RECORDER_TIMING } from "../recorder/timing";
import { EditApi } from "./edit-api";
import type { HandledEdit, Notice, RecordingChange, SubmittedEdit } from "./models";
import { editNotice } from "./plan";

const isHandled = (edit: SubmittedEdit): edit is HandledEdit => edit.outcome !== null;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface Saved {
  readonly sent: boolean;
  readonly notice: Notice | null;
}

@Service({ autoProvided: false })
export class EditSaver {
  private readonly api = inject(EditApi);

  private readonly timing = inject(RECORDER_TIMING);

  private readonly destroyRef = inject(DestroyRef);

  private readonly busy = signal(false);

  private readonly latest = signal<Notice | null>(null);

  readonly saving = this.busy.asReadonly();

  readonly notice = this.latest.asReadonly();

  save(recordingId: string, changes: ReadonlyArray<RecordingChange>, onSent: () => void): void {
    if (this.busy()) return;

    this.latest.set(null);

    if (changes.length === 0) {
      onSent();

      return;
    }

    this.busy.set(true);

    from(changes)
      .pipe(
        concatMap((change) =>
          this.api.submit(recordingId, change).pipe(switchMap(({ id }) => this.awaitOutcome(id))),
        ),
        toArray(),
        map((results): Saved => ({ sent: true, notice: editNotice(results) })),
        catchError((error) =>
          of<Saved>({ sent: false, notice: unreachableNotice(messageOf(error)) }),
        ),
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(({ sent, notice }) => {
        this.latest.set(notice);

        if (sent) onSent();
      });
  }

  private awaitOutcome(id: number): Observable<HandledEdit | null> {
    return timer(this.timing.requestPollMs).pipe(
      switchMap(() => this.api.find(id)),
      repeat(this.timing.requestPollLimit),
      first(isHandled, null),
    );
  }
}
