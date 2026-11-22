import { Button } from "@foldkit/ui";
import { Array } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

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
  const toView = (attributes: Button.ButtonAttributes<Message>): Html =>
    h.button(
      [
        ...attributes.button,
        h.Class(classOf(config)),
        ...(config.isBusy === undefined ? [] : [h.AriaBusy(config.isBusy)]),
      ],
      config.label,
    );

  const type = config.isSubmit === true ? "submit" : "button";
  const isDisabled = config.isDisabled === true;

  if (config.onClick === undefined) {
    return Button.view({ toView, type, isDisabled }, h);
  } else {
    return Button.view({ toView, type, isDisabled, onClick: config.onClick }, h);
  }
};

export interface BlockButtonConfig<Message> {
  readonly onClick: Message;
  readonly className: string;
  readonly children: ReadonlyArray<Content>;
}

export const blockButton = <Message>(
  h: HtmlBuilder<Message>,
  config: BlockButtonConfig<Message>,
): Html =>
  Button.view(
    {
      onClick: config.onClick,
      toView: (attributes) =>
        h.button([...attributes.button, h.Class(config.className)], config.children),
    },
    h,
  );
