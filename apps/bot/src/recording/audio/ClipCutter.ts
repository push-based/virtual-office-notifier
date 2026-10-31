import { Chunk, DateTime, Duration, Option } from "effect";

export const MAX_CLIP = Duration.minutes(5);

export interface Clip {
  readonly userId: string;
  readonly startedAt: DateTime.Utc;
  readonly packets: ReadonlyArray<Uint8Array>;
}

export interface PartialClip {
  readonly userId: string;
  readonly startedAt: DateTime.Utc;
  readonly packets: Chunk.Chunk<Uint8Array>;
  readonly duration: Duration.Duration;
}

export interface Cut {
  readonly partial: PartialClip;
  readonly finished: Option.Option<Clip>;
}

export const startClip = (userId: string, startedAt: DateTime.Utc): PartialClip => ({
  userId,
  startedAt,
  packets: Chunk.empty(),
  duration: Duration.zero,
});

const finish = ({ userId, startedAt, packets }: PartialClip): Option.Option<Clip> =>
  Chunk.isEmpty(packets)
    ? Option.none()
    : Option.some({ userId, startedAt, packets: Chunk.toReadonlyArray(packets) });

export const addPacket = (
  partial: PartialClip,
  packet: Uint8Array,
  packetDuration: Duration.Duration,
  now: DateTime.Utc,
): Cut => {
  const grown: PartialClip = {
    ...partial,
    packets: Chunk.append(partial.packets, packet),
    duration: Duration.sum(partial.duration, packetDuration),
  };

  return Duration.isGreaterThanOrEqualTo(grown.duration, MAX_CLIP)
    ? { partial: startClip(partial.userId, now), finished: finish(grown) }
    : { partial: grown, finished: Option.none() };
};

export const flush = (partial: PartialClip): Cut => ({
  partial: startClip(partial.userId, partial.startedAt),
  finished: finish(partial),
});
