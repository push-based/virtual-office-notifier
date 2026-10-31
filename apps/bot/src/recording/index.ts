import { Layer } from "effect";

import { VoiceCapture } from "./audio/index.ts";
import { ClipArchive } from "./ClipArchive.ts";
import { RecorderLayer } from "./Recorder.ts";
import { RecordingWriter } from "./RecordingWriter.ts";
import { Transcriber } from "./Transcriber.ts";

export { RecordingStore } from "./RecordingStore.ts";

export const RecordingLayer = RecorderLayer.pipe(
  Layer.provide([VoiceCapture.layer, ClipArchive.layer, Transcriber.layer, RecordingWriter.layer]),
);
