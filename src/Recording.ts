import { Duration, Schema } from "effect";

export const MIN_CLIP_DURATION = Duration.millis(500);

export const MAX_TRANSCRIPTION_ATTEMPTS = 10;

export const StopReason = Schema.Literals(["requested", "office_emptied", "time_limit", "bot_restarted"]);

export type StopReason = typeof StopReason.Type;

export const TranscriptionStatus = Schema.Literals(["pending", "done", "skipped", "failed"]);

export type TranscriptionStatus = typeof TranscriptionStatus.Type;
