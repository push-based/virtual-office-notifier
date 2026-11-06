import { Layer } from "effect";

import { VoiceCapture } from "./audio/index.ts";
import { ClipArchive } from "./ClipArchive.ts";
import { RecorderLayer } from "./Recorder.ts";
import { RecordingWriter } from "./RecordingWriter.ts";
import { Transcriber } from "./Transcriber.ts";

export { type ArchiveError, ClipArchive } from "./ClipArchive.ts";

export { RecordingStore, StoreUnavailable } from "./RecordingStore.ts";

export { StoreHealth } from "./StoreHealth.ts";

export const RecordingLayer = RecorderLayer.pipe(
  Layer.provide([VoiceCapture.layer, ClipArchive.layer, Transcriber.layer, RecordingWriter.layer]),
);
