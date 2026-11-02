import { Context, Effect, Layer, Option, Ref, Semaphore, Stream } from "effect";

import type { BotPresence } from "./BotPresence.ts";
import { DiscordGateway } from "./DiscordGateway.ts";

export const RECORDING_NICKNAME = "🔴 Recording";

export const PAUSED_NICKNAME = "⏸️ Recording paused";

export type RecordingMode = "Off" | "Capturing" | "Paused";

export interface SeatAdapter {
  join(listening: boolean): Effect.Effect<void>;
  readonly leave: Effect.Effect<void>;
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
>()("bot/office/OfficeSeat") {
  static readonly make = Effect.fnUntraced(function* (adapter: SeatAdapter) {
    const wanted = yield* Ref.make<BotPresence>("Away");
    const recording = yield* Ref.make<RecordingMode>("Off");
    const moving = yield* Semaphore.make(1);

    const sit = (presence: BotPresence, mode: RecordingMode) => {
      if (mode === "Capturing") return adapter.join(true);

      return presence === "InOffice" ? adapter.join(false) : adapter.leave;
    };

    const goWhereWanted = Effect.all([Ref.get(wanted), Ref.get(recording)]).pipe(
      Effect.flatMap(([presence, mode]) =>
        sit(presence, mode).pipe(
          Effect.andThen(Effect.logInfo("Moved the bot")),
          Effect.annotateLogs({ presence, listening: mode === "Capturing" }),
        ),
      ),
      moving.withPermits(1),
    );

    const want = (presence: BotPresence) =>
      Ref.set(wanted, presence).pipe(Effect.andThen(goWhereWanted));

    const record = (mode: RecordingMode) =>
      Ref.set(recording, mode).pipe(
        Effect.andThen(adapter.rename(nicknameFor(mode))),
        Effect.andThen(goWhereWanted),
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
