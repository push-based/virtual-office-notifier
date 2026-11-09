import { Array, Context, Effect, Layer, Option, pipe, Schema, Stream, String } from "effect";
import type { Admin } from "recording-requests/Admins";
import type { ErasureCase, RefusalGround } from "recording-requests/Consent";
import { RefusalGround as RefusalGroundSchema } from "recording-requests/Consent";
import type { ErasureNotice } from "recording-requests/ConsentRequests";
import { REFUSAL_GROUNDS } from "recording-requests/wire";

import { Notice } from "../consent/index.ts";
import type { AdminLine, ErasureAction, ErasureVerdict } from "../office/index.ts";
import {
  type ActionButton,
  type ActionsBlock,
  type InteractionPayload,
  mrkdwn,
  type SectionBlock,
  SlackClient,
  type SlackError,
  SlackSocket,
} from "../slack/index.ts";

const SECTION_LIMIT = 2900;

const ACTION_PREFIX = "erasure_";

const REFUSE_CALLBACK = "erasure_refuse";

const RefusalMetadata = Schema.fromJsonString(
  Schema.Struct({ id: Schema.Finite, ground: RefusalGroundSchema, channel: Schema.String }),
);

const decodeMetadata = Schema.decodeUnknownOption(RefusalMetadata);

const encodeMetadata = (metadata: { id: number; ground: RefusalGround; channel: string }) =>
  JSON.stringify(metadata);

const sectionsOf = (text: string): ReadonlyArray<SectionBlock> => {
  const sections: Array<string> = [];

  for (const paragraph of String.split(text, "\n\n")) {
    const last = sections.at(-1);

    if (last !== undefined && last.length + paragraph.length + 2 <= SECTION_LIMIT)
      sections[sections.length - 1] = `${last}\n\n${paragraph}`;
    else sections.push(paragraph);
  }

  return Array.map(sections, (section): SectionBlock => ({
    type: "section",
    text: mrkdwn(section),
  }));
};

const button = (
  label: string,
  actionId: string,
  value: string,
  style?: "primary" | "danger",
): ActionButton => {
  const plain: ActionButton = {
    type: "button",
    text: { type: "plain_text", text: label, emoji: true },
    action_id: actionId,
    value,
  };

  return style === undefined ? plain : { ...plain, style };
};

const buttonsFor = (erasure: ErasureCase): ActionsBlock => ({
  type: "actions",
  elements: [
    button(Notice.DELETE_NOW_LABEL, `${ACTION_PREFIX}now`, `${erasure.id}`, "danger"),
    button(Notice.LET_IT_RUN_LABEL, `${ACTION_PREFIX}seen`, `${erasure.id}`),
    button(
      Notice.REFUSE_LABELS.legal_obligation,
      `${ACTION_PREFIX}refuse_legal_obligation`,
      `${erasure.id}`,
    ),
    button(Notice.REFUSE_LABELS.legal_claim, `${ACTION_PREFIX}refuse_legal_claim`, `${erasure.id}`),
  ],
});

const refusalModal = (id: number, ground: RefusalGround, channel: string): Schema.Json => ({
  type: "modal",
  callback_id: REFUSE_CALLBACK,
  private_metadata: encodeMetadata({ id, ground, channel }),
  title: { type: "plain_text", text: Notice.REFUSAL_MODAL_TITLE },
  submit: { type: "plain_text", text: "Refuse" },
  close: { type: "plain_text", text: "Keep it open" },
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Refusing because of *${REFUSAL_GROUNDS[ground]}*, for request #${id}.`,
      },
    },
    {
      type: "input",
      block_id: "reason",
      label: { type: "plain_text", text: Notice.REFUSAL_REASON_LABEL },
      element: { type: "plain_text_input", action_id: "reason", multiline: true, max_length: 1000 },
    },
  ],
});

const groundOf = (actionId: string): Option.Option<RefusalGround> =>
  Schema.decodeUnknownOption(RefusalGroundSchema)(
    pipe(actionId, String.slice(`${ACTION_PREFIX}refuse_`.length)),
  );

const verdictOf = (actionId: string): Option.Option<"now" | "seen" | RefusalGround> =>
  actionId === `${ACTION_PREFIX}now`
    ? Option.some("now")
    : actionId === `${ACTION_PREFIX}seen`
      ? Option.some("seen")
      : pipe(actionId, String.startsWith(`${ACTION_PREFIX}refuse_`))
        ? groundOf(actionId)
        : Option.none();

const logFailure = (message: string) => (error: SlackError) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ reason: error.reason._tag }));

export class SlackAdminLine extends Context.Service<SlackAdminLine, AdminLine>()(
  "bot/reception/SlackAdminLine",
) {
  static readonly layer = Layer.effect(
    SlackAdminLine,
    Effect.gen(function* () {
      const slack = yield* SlackClient;
      const socket = yield* SlackSocket;

      const say = (channel: string, text: string) =>
        slack
          .postMessage({ channel, text, blocks: sectionsOf(text) })
          .pipe(Effect.asVoid, Effect.catch(logFailure("Couldn't answer an admin in Slack")));

      const postNotice = (slackUserId: string, erasure: ErasureCase) =>
        slack.openDirectMessage(slackUserId).pipe(
          Effect.flatMap((channel) => {
            const text = Notice.adminNotice(erasure, "slack");

            return slack.postMessage({
              channel,
              text,
              blocks: [...sectionsOf(text), buttonsFor(erasure)],
            });
          }),
          Effect.map((posted) => Option.some({ channel: posted.channel, messageId: posted.ts })),
          Effect.catch((error) =>
            logFailure("Couldn't tell an admin in Slack about a deletion request")(error).pipe(
              Effect.as(Option.none()),
            ),
          ),
        );

      const notify = (admin: Admin, erasure: ErasureCase) =>
        admin.slackUserId === null ? Effect.succeedNone : postNotice(admin.slackUserId, erasure);

      const update = (notice: ErasureNotice, text: string) =>
        slack
          .updateMessage(notice.channel, notice.messageId, { text, blocks: sectionsOf(text) })
          .pipe(Effect.catch(logFailure("Couldn't update an admin's Slack message")));

      const fromButton = (
        payload: Extract<InteractionPayload, { readonly type: "block_actions" }>,
      ): Effect.Effect<Option.Option<ErasureAction>> => {
        const pressed = Option.flatMap(Array.head(payload.actions), (action) =>
          Option.all({
            verdict: verdictOf(action.action_id),
            requestId: Option.flatMap(Option.fromUndefinedOr(action.value), (value) =>
              Number.isInteger(Number(value)) ? Option.some(Number(value)) : Option.none(),
            ),
          }),
        );

        if (Option.isNone(pressed)) return Effect.succeedNone;

        const channel = payload.channel?.id;
        const reply = (text: string) => (channel === undefined ? Effect.void : say(channel, text));
        const { verdict, requestId } = pressed.value;

        if (verdict === "now" || verdict === "seen")
          return Effect.succeedSome({
            requestId,
            userId: payload.user.id,
            verdict: { kind: verdict },
            reply,
          });

        return slack
          .openView(payload.trigger_id, refusalModal(requestId, verdict, channel ?? ""))
          .pipe(
            Effect.catch(logFailure("Couldn't open the refusal form in Slack")),
            Effect.as(Option.none()),
          );
      };

      const fromSubmission = (
        payload: Extract<InteractionPayload, { readonly type: "view_submission" }>,
      ): Option.Option<ErasureAction> => {
        if (payload.view.callback_id !== REFUSE_CALLBACK) return Option.none();

        const metadata = decodeMetadata(payload.view.private_metadata ?? "");

        const reason = pipe(
          payload.view.state.values["reason"]?.["reason"]?.value ?? "",
          String.trim,
        );

        if (Option.isNone(metadata) || reason === "") return Option.none();

        const verdict: ErasureVerdict = { kind: "refuse", ground: metadata.value.ground, reason };

        return Option.some({
          requestId: metadata.value.id,
          userId: payload.user.id,
          verdict,
          reply: (text) =>
            metadata.value.channel === "" ? Effect.void : say(metadata.value.channel, text),
        });
      };

      const actions = socket.envelopes.pipe(
        Stream.mapEffect((envelope) =>
          Option.match(envelope.interaction, {
            onNone: () => Effect.succeedNone,
            onSome: (payload) =>
              payload.type === "block_actions"
                ? fromButton(payload)
                : Effect.succeed(fromSubmission(payload)),
          }),
        ),
        Stream.filter(Option.isSome),
        Stream.map((found) => found.value),
      );

      return SlackAdminLine.of({ medium: "slack", notify, update, actions });
    }),
  );
}
