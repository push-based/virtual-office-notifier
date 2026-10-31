import { Array, Data, DateTime, Duration } from "effect";

export const SPEAKING_HOLD = Duration.seconds(2);

export type Voice = Data.TaggedEnum<{
  Talking: {};
  Pausing: { readonly since: DateTime.Utc };
}>;

export const Voice = Data.taggedEnum<Voice>();

export type Voices = ReadonlyMap<string, Voice>;

export const noVoices: Voices = new Map();

export const startedSpeaking = (voices: Voices, userId: string): Voices =>
  new Map(voices).set(userId, Voice.Talking());

export const stoppedSpeaking = (voices: Voices, userId: string, at: DateTime.Utc): Voices =>
  voices.has(userId) ? new Map(voices).set(userId, Voice.Pausing({ since: at })) : voices;

const isHeldAt = (voice: Voice, now: DateTime.Utc): boolean =>
  Voice.$match(voice, {
    Talking: () => true,
    Pausing: ({ since }) => Duration.isLessThan(DateTime.distance(since, now), SPEAKING_HOLD),
  });

export const speakingAt = (voices: Voices, now: DateTime.Utc): ReadonlySet<string> =>
  new Set(Array.flatMap([...voices], ([userId, voice]) => (isHeldAt(voice, now) ? [userId] : [])));
