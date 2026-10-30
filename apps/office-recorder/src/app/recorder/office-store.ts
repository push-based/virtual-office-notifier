import { DestroyRef, Service, computed, inject, signal } from "@angular/core";
import { takeUntilDestroyed, toSignal } from "@angular/core/rxjs-interop";
import {
  EMPTY,
  type Observable,
  Subject,
  catchError,
  concatMap,
  defer,
  distinctUntilChanged,
  finalize,
  first,
  interval,
  map,
  merge,
  mergeMap,
  of,
  repeat,
  share,
  startWith,
  switchMap,
  tap,
  timer,
} from "rxjs";

import { EMPTY_DRAFT, type Draft, planOf } from "../edits/plan";
import type {
  HandledRequest,
  Notice,
  OfficePhase,
  RecordingStatus,
  SubmittedRequest,
} from "./models";
import { describePresence, samePresence } from "./describe-presence";
import { outcomeNotice, unreachableNotice } from "./notices";
import { RecorderApi } from "./recorder-api";
import { RecorderSession } from "./session";
import { RECORDER_TIMING } from "./timing";

interface OfficeState {
  readonly status: RecordingStatus | null;
  readonly failure: string | null;
  readonly busy: boolean;
  readonly now: number;
}

const isHandled = (request: SubmittedRequest): request is HandledRequest =>
  request.outcome !== null;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

@Service({ autoProvided: false })
export class OfficeStore {
  private readonly api = inject(RecorderApi);

  private readonly session = inject(RecorderSession);

  private readonly timing = inject(RECORDER_TIMING);

  private readonly destroyRef = inject(DestroyRef);

  private readonly refreshes = new Subject<void>();

  private readonly notices = new Subject<Notice>();

  private readonly state = signal<OfficeState>({
    status: null,
    failure: null,
    busy: false,
    now: Date.now(),
  });

  readonly status = computed(() => this.state().status);

  readonly draftTitle = signal(EMPTY_DRAFT.title);

  readonly draftAgenda = signal(EMPTY_DRAFT.agenda);

  readonly draftSummaryStyle = signal(EMPTY_DRAFT.summaryStyle);

  readonly running = computed(() => this.status()?.recording ?? null);

  readonly busy = computed(() => this.state().busy);

  readonly now = computed(() => this.state().now);

  readonly notice = toSignal(
    this.notices.pipe(
      switchMap((notice) =>
        timer(this.timing.noticeMs).pipe(
          map(() => null),
          startWith(notice),
        ),
      ),
    ),
    { initialValue: null },
  );

  readonly phase = computed((): OfficePhase => {
    const { failure, status } = this.state();

    if (failure !== null) return { kind: "failed", reason: failure };

    if (status === null) return { kind: "connecting" };

    const { recording } = status;

    if (recording !== null)
      return recording.pause === null
        ? { kind: "recording", recording }
        : { kind: "paused", recording, pause: recording.pause };

    return status.botInOffice ? { kind: "idle" } : { kind: "away" };
  });

  readonly recording = computed(() => (this.status()?.recording ?? null) !== null);

  readonly paused = computed(() => this.phase().kind === "paused");

  readonly occupants = computed(() => this.status()?.occupants ?? []);

  readonly canPress = computed(() => !this.busy() && this.status()?.botInOffice === true);

  async start(): Promise<void> {
    try {
      await this.session.signIn();
    } catch (error) {
      this.patch({ failure: messageOf(error) });

      return;
    }

    if (this.destroyRef.destroyed) return;

    const statuses = merge(
      timer(0).pipe(
        switchMap(() =>
          defer(() => this.fetchStatus()).pipe(repeat({ delay: () => timer(this.pollMs()) })),
        ),
      ),
      this.refreshes.pipe(mergeMap(() => this.fetchStatus())),
    ).pipe(takeUntilDestroyed(this.destroyRef), share());

    statuses.subscribe((status) => this.patch({ status, now: Date.now() }));

    statuses
      .pipe(
        map(describePresence),
        distinctUntilChanged(samePresence),
        concatMap((presence) => this.session.showPresence(presence)),
      )
      .subscribe();

    interval(this.timing.clockTickMs)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.patch({ now: Date.now() }));
  }

  press(): void {
    const status = this.state().status;

    if (status === null) return;

    if (status.recording !== null) {
      this.submit(() => this.api.submit("stop"));

      return;
    }

    const draft: Draft = {
      title: this.draftTitle(),
      agenda: this.draftAgenda(),
      summaryStyle: this.draftSummaryStyle(),
    };

    this.submit(() => this.api.submit("start", planOf(draft)));
  }

  refresh(): void {
    this.refreshes.next();
  }

  pressPause(): void {
    const recording = this.state().status?.recording ?? null;

    if (recording === null) return;

    this.submit(() => this.api.submit(recording.pause === null ? "pause" : "resume"));
  }

  private submit(send: () => Observable<SubmittedRequest>): void {
    if (this.state().busy) return;

    this.patch({ busy: true });

    send()
      .pipe(
        switchMap(({ id }) => this.awaitOutcome(id)),
        tap((handled) => {
          if (handled?.outcome === "started") this.clearDraft();
        }),
        map(outcomeNotice),
        catchError((error) => of(unreachableNotice(messageOf(error)))),
        finalize(() => {
          this.patch({ busy: false });
          this.refreshes.next();
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((notice) => this.notices.next(notice));
  }

  private pollMs(): number {
    return this.recording() ? this.timing.recordingPollMs : this.timing.statePollMs;
  }

  private fetchStatus(): Observable<RecordingStatus> {
    return this.api.status().pipe(
      catchError((error) => {
        this.notices.next(unreachableNotice(messageOf(error)));

        return EMPTY;
      }),
    );
  }

  private awaitOutcome(id: number): Observable<HandledRequest | null> {
    return timer(this.timing.requestPollMs).pipe(
      switchMap(() => this.api.find(id)),
      repeat(this.timing.requestPollLimit),
      first(isHandled, null),
    );
  }

  private clearDraft(): void {
    this.draftTitle.set(EMPTY_DRAFT.title);
    this.draftAgenda.set(EMPTY_DRAFT.agenda);
    this.draftSummaryStyle.set(EMPTY_DRAFT.summaryStyle);
  }

  private patch(changes: Partial<OfficeState>): void {
    this.state.update((state) => ({ ...state, ...changes }));
  }
}
