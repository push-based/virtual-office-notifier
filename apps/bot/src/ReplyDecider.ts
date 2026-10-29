import { NodeHttpClient } from "@effect/platform-node";
import {
  Array,
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  Option,
  type Redacted,
  Schema,
} from "effect";
import { Decision, DecisionModel } from "effect/ai";
import { HttpClient } from "effect/http";

import { CloudflareDecisionModel, clefRequest } from "./CloudflareDecisionModel.ts";
import { AiConfig } from "./Config.ts";
import type { Action, ClefVerdict, DecisionReason, ResponderSettings } from "./SlackHistory.ts";

const CLEF_TIMEOUT = Duration.seconds(15);

const Line = Schema.Struct({ who: Schema.String, text: Schema.String });

const ClefStateSchema = Schema.Struct({
  botPost: Line,
  earlier: Schema.Array(Line),
  message: Line,
});

export type ClefState = typeof ClefStateSchema.Type;

const encodeState = Schema.encodeEffect(Schema.toCodecJson(ClefStateSchema));

const engagement = (reactionEmoji: Array.NonEmptyReadonlyArray<string>) =>
  Decision.make({
    input: ClefStateSchema,
    decisions: {
      action: Decision.classify({
        instructions:
          "A team's Slack bot posts announcements and playful banter about their virtual office, a Discord voice channel where they work alongside each other. Someone wrote a new message in a thread under one of the bot's posts. Decide what the bot should do with the new message.",
        criteria: {
          reply: "Someone asks the bot something, reacts to what it said, or invites it to respond.",
          react: "An acknowledgement, a laugh or a joke that needs no words from the bot.",
          ignore: "People are talking to each other, not to the bot.",
        },
      }),
      reaction: Decision.classify({
        instructions: "Pick the emoji reaction that fits the new message best.",
        criteria: Object.fromEntries(reactionEmoji.map((emoji) => [emoji, null])),
      }),
    },
  });

export class ClefFailed extends Schema.TaggedError<ClefFailed>()("ClefFailed", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Clef couldn't decide whether to answer: ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

export interface Judgement {
  readonly act: Action;
  readonly reason: Extract<DecisionReason, "clef" | "low_confidence">;
}

export const judge = (verdict: ClefVerdict, minConfidence: number): Judgement => {
  if (verdict.action === "ignore") return { act: "ignore", reason: "clef" };

  return verdict.actionConfidence >= minConfidence
    ? { act: verdict.action, reason: "clef" }
    : { act: "ignore", reason: "low_confidence" };
};

export interface Decided {
  readonly verdict: ClefVerdict;
  readonly judgement: Judgement;
}

const confidenceOf = (answer: Decision.ClassifyAnswer<string>): number =>
  answer.confidence ?? answer.probabilities[answer.label] ?? 0;

interface Credentials {
  readonly accountId: Redacted.Redacted<string>;
  readonly apiToken: Redacted.Redacted<string>;
}

export class ReplyDecider extends Context.Service<
  ReplyDecider,
  {
    decide(state: ClefState, settings: ResponderSettings): Effect.Effect<Decided, ClefFailed>;
  }
>()("virtual-office-notifier/ReplyDecider") {
  static readonly layerNoDeps = Layer.effect(
    ReplyDecider,
    Effect.gen(function* () {
      const { cloudflare } = yield* AiConfig;
      const client = yield* HttpClient.HttpClient;

      const credentials = Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken });

      if (Option.isNone(credentials)) {
        yield* Effect.logInfo("Cloudflare isn't configured, so only mentions are answered");
      }

      const decideWith = Effect.fnUntraced(function* (
        { accountId, apiToken }: Credentials,
        state: ClefState,
        settings: ResponderSettings,
      ) {
        const definition = engagement(settings.reactionEmoji);
        const stateJson = yield* encodeState(state);
        const request = clefRequest(stateJson, definition.decisions);

        const model = yield* CloudflareDecisionModel.make({ accountId, apiToken, model: settings.clefModel }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );

        const [took, { answers }] = yield* DecisionModel.decide(definition, { input: state }).pipe(
          Effect.provideService(DecisionModel.DecisionModel, model),
          Effect.timeout(CLEF_TIMEOUT),
          Effect.timed,
        );

        const verdict: ClefVerdict = {
          model: settings.clefModel,
          request,
          action: answers.action.label,
          actionProbabilities: answers.action.probabilities,
          actionConfidence: confidenceOf(answers.action),
          reaction: answers.reaction.label,
          reactionProbabilities: answers.reaction.probabilities,
          reactionConfidence: confidenceOf(answers.reaction),
          latencyMs: Math.round(Duration.toMillis(took)),
        };

        return { verdict, judgement: judge(verdict, settings.minConfidence) };
      });

      const decide = Effect.fn("ReplyDecider.decide")(
        (state: ClefState, settings: ResponderSettings) =>
          Option.match(credentials, {
            onNone: () => Effect.fail(new ClefFailed({ reason: "NotConfigured" })),
            onSome: (configured) =>
              decideWith(configured, state, settings).pipe(
                Effect.catchTags({
                  AiError: (error) => Effect.fail(new ClefFailed({ reason: error.reason._tag })),
                  TimeoutError: () => Effect.fail(new ClefFailed({ reason: "Timeout" })),
                  SchemaError: () => Effect.fail(new ClefFailed({ reason: "InvalidState" })),
                }),
              ),
          }),
      );

      return ReplyDecider.of({ decide });
    }),
  );

  static readonly layer = ReplyDecider.layerNoDeps.pipe(Layer.provide(NodeHttpClient.layerUndici));
}
