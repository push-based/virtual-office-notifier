import { Array } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export type ButtonVariant = "primary" | "ghost" | "tertiary";

export type ButtonSize = "md" | "lg";

export interface ButtonConfig<Message> {
  readonly label: ReadonlyArray<Content>;
  readonly onClick?: Message;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly isFullWidth?: boolean;
  readonly isDisabled?: boolean;
  readonly isBusy?: boolean;
  readonly isSubmit?: boolean;
  readonly className?: string;
}

const classOf = <Message>(config: ButtonConfig<Message>): string =>
  Array.join(
    [
      "pb-btn",
      `pb-btn-${config.variant ?? "primary"}`,
      ...(config.size === "lg" ? ["pb-btn-lg"] : []),
      ...(config.isFullWidth === true ? ["pb-btn-full"] : []),
      ...(config.className === undefined ? [] : [config.className]),
    ],
    " ",
  );

export const button = <Message>(h: HtmlBuilder<Message>, config: ButtonConfig<Message>): Html => {
  const isDisabled = config.isDisabled === true;

  const attributes: ReadonlyArray<Attribute<Message>> = [
    h.Type(config.isSubmit === true ? "submit" : "button"),
    h.Class(classOf(config)),
    ...(isDisabled ? [h.AriaDisabled(true)] : []),
    ...(isDisabled || config.onClick === undefined ? [] : [h.OnClick(config.onClick)]),
    ...(config.isBusy === undefined ? [] : [h.AriaBusy(config.isBusy)]),
  ];

  return h.button(attributes, config.label);
};

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
      h.span([h.Class("pb-record-button-icon"), h.AriaHidden(true)]),
      config.isRecording ? "Stop recording" : "Start recording",
    ],
    onClick: config.onPress,
    size: "lg",
    isFullWidth: true,
    isDisabled: config.isDisabled,
    isBusy: config.isBusy,
    className: config.isRecording
      ? "pb-record-button pb-record-button-recording"
      : "pb-record-button",
  });
