import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export interface ConfirmBoxConfig<Message> {
  readonly children: ReadonlyArray<Content>;
  readonly isDanger?: boolean;
  readonly labelledBy?: string;
  readonly onSubmit?: Message;
}

const classOf = <Message>(config: ConfirmBoxConfig<Message>): string =>
  config.isDanger === true ? "pb-confirm pb-confirm-danger" : "pb-confirm";

export const confirmBox = <Message>(
  h: HtmlBuilder<Message>,
  config: ConfirmBoxConfig<Message>,
): Html => {
  if (config.onSubmit === undefined) {
    return h.div(
      [
        h.Class(classOf(config)),
        h.Role("group"),
        ...(config.labelledBy === undefined ? [] : [h.AriaLabelledBy(config.labelledBy)]),
      ],
      config.children,
    );
  } else {
    return h.form([h.Class(classOf(config)), h.OnSubmit(config.onSubmit)], config.children);
  }
};
