import type { Html, HtmlBuilder } from "foldkit/html";

import type { Content } from "./content.ts";

export type NoticeKind = "info" | "error";

export interface NoticeContent {
  readonly kind: NoticeKind;
  readonly text: string;
}

export const notice = <Message>(h: HtmlBuilder<Message>, shown: NoticeContent): Html =>
  h.div(
    [
      h.Class(
        shown.kind === "error"
          ? "text-body-sm pb-notice pb-notice-error"
          : "text-body-sm pb-notice",
      ),
    ],
    [shown.text],
  );

export const noticeRegion = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Content>,
): Html => h.div([h.Class("pb-notice-region"), h.Role("status")], children);
