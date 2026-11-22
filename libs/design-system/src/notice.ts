import { Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

export const NoticeKind = Schema.Literals(["info", "error"]);

export type NoticeKind = typeof NoticeKind.Type;

export const NoticeContent = Schema.Struct({ kind: NoticeKind, text: Schema.String });

export type NoticeContent = typeof NoticeContent.Type;

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
  maybeNotice: Option.Option<NoticeContent>,
): Html =>
  h.div(
    [h.Class("pb-notice-region"), h.Role("status")],
    Option.match(maybeNotice, { onNone: () => [], onSome: (shown) => [notice(h, shown)] }),
  );
