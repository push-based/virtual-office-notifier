import { DestroyRef, Service, computed, inject, signal } from "@angular/core";
import { takeUntilDestroyed, toObservable } from "@angular/core/rxjs-interop";
import {
  BehaviorSubject,
  EMPTY,
  type Observable,
  catchError,
  filter,
  finalize,
  map,
  switchMap,
  take,
  takeWhile,
  tap,
  timer,
} from "rxjs";

import { RecorderSession } from "../recorder/session";
import { isLive } from "./describe-recording";
import { HistoryApi } from "./history-api";
import { EMPTY_HISTORY, type HistoryList, withNewest, withOlder } from "./history-list";
import { HISTORY_TIMING } from "./history-timing";
import type { RecordingDetail } from "./models";

interface HistoryState {
  readonly list: HistoryList;
  readonly loaded: boolean;
  readonly loadingOlder: boolean;
  readonly open: RecordingDetail | null;
  readonly failure: string | null;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

@Service({ autoProvided: false })
export class HistoryStore {
  private readonly api = inject(HistoryApi);

  private readonly session = inject(RecorderSession);

  private readonly timing = inject(HISTORY_TIMING);

  private readonly destroyRef = inject(DestroyRef);

  private readonly state = signal<HistoryState>({
    list: EMPTY_HISTORY,
    loaded: false,
    loadingOlder: false,
    open: null,
    failure: null,
  });

  private readonly opened = new BehaviorSubject<string | null>(null);

  private readonly openedId = signal<string | null>(null);

  readonly recordings = computed(() => this.state().list.recordings);

  readonly loaded = computed(() => this.state().loaded);

  readonly hasOlder = computed(() => this.state().list.older !== null);

  readonly loadingOlder = computed(() => this.state().loadingOlder);

  readonly openId = this.openedId.asReadonly();

  readonly open = computed(() => {
    const { open } = this.state();

    return open !== null && open.id === this.openedId() ? open : null;
  });

  readonly failure = computed(() => this.state().failure);

  private readonly signedIn = toObservable(this.session.token).pipe(
    filter((token) => token !== null),
    take(1),
  );

  constructor() {
    this.signedIn
      .pipe(
        switchMap(() => this.opened),
        switchMap((openId) => (openId === null ? this.pollList() : this.pollRecording(openId))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  showOlder(): void {
    const { list, loadingOlder } = this.state();

    if (loadingOlder || list.older === null) return;

    this.patch({ loadingOlder: true });

    this.api
      .page(list.older)
      .pipe(
        catchError((error) => this.failed(error)),
        finalize(() => this.patch({ loadingOlder: false })),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((page) => this.patch({ list: withOlder(this.state().list, page), failure: null }));
  }

  openRecording(id: string): void {
    this.show(id);
  }

  back(): void {
    this.show(null);
  }

  openInSlack(url: string): void {
    this.session.openExternalLink(url).catch((cause: unknown) => {
      this.patch({ failure: messageOf(cause) });
    });
  }

  private show(id: string | null): void {
    this.openedId.set(id);
    this.patch({ open: null, failure: null });
    this.opened.next(id);
  }

  private pollList(): Observable<void> {
    return timer(0, this.timing.listPollMs).pipe(
      switchMap(() => this.api.page(null).pipe(catchError((error) => this.failed(error)))),
      map((page) =>
        this.patch({
          list: withNewest(this.state().list, page),
          loaded: true,
          failure: null,
        }),
      ),
    );
  }

  private pollRecording(id: string): Observable<RecordingDetail> {
    return timer(0, this.timing.recordingPollMs).pipe(
      switchMap(() => this.api.recording(id).pipe(catchError((error) => this.failed(error)))),
      tap((open) => this.patch({ open, failure: null })),
      takeWhile((open) => isLive(open.state)),
    );
  }

  private failed(cause: unknown): Observable<never> {
    this.patch({ failure: messageOf(cause) });

    return EMPTY;
  }

  private patch(changes: Partial<HistoryState>): void {
    this.state.update((state) => ({ ...state, ...changes }));
  }
}
