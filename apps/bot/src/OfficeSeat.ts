import { Context, Duration, Effect, Layer, Option, Ref, Schedule, Semaphore, Stream } from "effect";

import type { BotPresence } from "./BotPresence.ts";
import { type BotMoveError, DiscordGateway } from "./DiscordGateway.ts";

export const RECORDING_NICKNAME = "🔴 Recording";

export const PAUSED_NICKNAME = "⏸️ Recording paused";

export const LEAVE_TIMEOUT = Duration.seconds(5);

export type RecordingMode = "Off" | "Capturing" | "Paused";

export interface SeatAdapter {
  readonly officeChannelId: string;
  move(channelId: string | null): Effect.Effect<void, BotMoveError>;
  readonly inVoice: Effect.Effect<boolean>;
  rename(nickname: string | null): Effect.Effect<void>;
  readonly reconnected: Stream.Stream<void>;
}

const nicknameFor = (mode: RecordingMode): string | null => {
  switch (mode) {
    case "Off":
      return null;
    case "Capturing":
      return RECORDING_NICKNAME;
    case "Paused":
      return PAUSED_NICKNAME;
  }
};

export class OfficeSeat extends Context.Service<
  OfficeSeat,
  {
    want(presence: BotPresence): Effect.Effect<void>;
    record(mode: RecordingMode): Effect.Effect<void>;
  }
>()("bot/OfficeSeat") {
  static readonly make = Effect.fnUntraced(function* (adapter: SeatAdapter) {
    const wanted = yield* Ref.make<BotPresence>("Away");
    const recording = yield* Ref.make<RecordingMode>("Off");
    const moving = yield* Semaphore.make(1);
    const oneMoveAtATime = moving.withPermits(1);

    const moveTo = (presence: BotPresence) =>
      adapter.move(presence === "InOffice" ? adapter.officeChannelId : null).pipe(
        Effect.andThen(Effect.logInfo("Moved the bot")),
        Effect.catchTag("BotMoveError", (error) =>
          Effect.logWarning("Couldn't move the bot").pipe(
            Effect.annotateLogs({ reason: error.reason }),
          ),
        ),
        Effect.annotateLogs({ presence }),
      );

    const goWhereWanted = Effect.all([Ref.get(wanted), Ref.get(recording)]).pipe(
      Effect.flatMap(([presence, mode]) => (mode === "Capturing" ? Effect.void : moveTo(presence))),
      oneMoveAtATime,
    );

    const stepOut = adapter.move(null).pipe(
      Effect.andThen(
        adapter.inVoice.pipe(
          Effect.repeat({
            until: (inVoice) => !inVoice,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeoutOption(LEAVE_TIMEOUT),
        ),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.logWarning("Discord didn't confirm the bot left the office before recording"),
          onSome: () => Effect.void,
        }),
      ),
      Effect.catchTag("BotMoveError", (error) =>
        Effect.logWarning("Couldn't step out of the office before recording").pipe(
          Effect.annotateLogs({ reason: error.reason }),
        ),
      ),
    );

    const want = (presence: BotPresence) =>
      Ref.set(wanted, presence).pipe(Effect.andThen(goWhereWanted));

    const record = (mode: RecordingMode) =>
      Ref.set(recording, mode).pipe(
        Effect.andThen(adapter.rename(nicknameFor(mode))),
        Effect.andThen(mode === "Capturing" ? oneMoveAtATime(stepOut) : goWhereWanted),
      );

    yield* Stream.runForEach(adapter.reconnected, () => goWhereWanted).pipe(Effect.forkScoped);

    return OfficeSeat.of({ want, record });
  });

  static readonly layer = Layer.effect(
    OfficeSeat,
    Effect.gen(function* () {
      const gateway = yield* DiscordGateway;

      return yield* Option.match(gateway.seat, {
        onNone: () =>
          Effect.succeed(OfficeSeat.of({ want: () => Effect.void, record: () => Effect.void })),
        onSome: OfficeSeat.make,
      });
    }),
  );
}
