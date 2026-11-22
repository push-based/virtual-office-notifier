import { button } from "design-system";
import type { Html, HtmlBuilder } from "foldkit/html";

export interface RecordButtonConfig<Message> {
  readonly isRecording: boolean;
  readonly isBusy: boolean;
  readonly isDisabled: boolean;
  readonly onPress: Message;
}

export const recordButton = <Message>(
  h: HtmlBuilder<Message>,
  config: RecordButtonConfig<Message>,
): Html =>
  button(h, {
    label: [
      h.span([h.Class("record-button-icon"), h.AriaHidden(true)]),
      config.isRecording ? "Stop recording" : "Start recording",
    ],
    onClick: config.onPress,
    size: "lg",
    isFullWidth: true,
    isDisabled: config.isDisabled,
    isBusy: config.isBusy,
    className: config.isRecording ? "record-button record-button-recording" : "record-button",
  });
