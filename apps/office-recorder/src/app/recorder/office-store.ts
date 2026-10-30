import { DestroyRef, Service, computed, inject, signal } from "@angular/core";
import { takeUntilDestroyed, toSignal } from "@angular/core/rxjs-interop";
import {
  EMPTY,
  type Observable,
  Subject,
  catchError,
  defer,
  finalize,
  first,
  interval,
  map,
  merge,
  mergeMap,
  of,
  repeat,
  startWith,
  switchMap,
  timer,
} from "rxjs";

import type {
  HandledRequest,
  Notice,
  OfficePhase,
  RecordingStatus,
  SubmittedRequest,
} from "./models";
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

    if (status.recording !== null) return { kind: "recording", recording: status.recording };

    return status.botInOffice ? { kind: "idle" } : { kind: "away" };
  });

  readonly recording = computed(() => this.phase().kind === "recording");

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

    merge(
      defer(() => this.fetchStatus()).pipe(repeat({ delay: () => timer(this.pollMs()) })),
      this.refreshes.pipe(mergeMap(() => this.fetchStatus())),
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((status) => this.patch({ status, now: Date.now() }));

    interval(this.timing.clockTickMs)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.patch({ now: Date.now() }));
  }

  press(): void {
    const { busy, status } = this.state();

    if (busy || status === null) return;

    this.patch({ busy: true });

    this.api
      .submit(status.recording === null ? "start" : "stop")
      .pipe(
        switchMap(({ id }) => this.awaitOutcome(id)),
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

  private patch(changes: Partial<OfficeState>): void {
    this.state.update((state) => ({ ...state, ...changes }));
  }
}
