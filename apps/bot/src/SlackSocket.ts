import { NodeSocket } from "@effect/platform-node";
import {
  Cause,
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Socket } from "effect/socket";

import { type SlackError, SlackClient } from "./SlackClient.ts";
import { decodeEnvelope, type Envelope } from "./SlackEvent.ts";

export class SlackSocketDropped extends Schema.TaggedError<
  SlackSocketDropped,
  { readonly brand: unique symbol }
>()("SlackSocketDropped", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Lost the Slack Socket Mode connection: ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

const MAX_RECONNECT_DELAY = Duration.minutes(5);

const REPORT_AFTER_FAILURES = 3;

const dropped = (error: Socket.SocketError) =>
  SlackSocketDropped.make({ reason: error.reason._tag });

const backoff = (attempt: number): Duration.Duration =>
  Duration.min(Duration.seconds(2 ** (attempt - 1)), MAX_RECONNECT_DELAY);

const reconnectAfter = Effect.fnUntraced(function* (
  error: SlackError | SlackSocketDropped,
  failures: Ref.Ref<number>,
) {
  const attempt = yield* Ref.updateAndGet(failures, (count) => count + 1);
  const delay = backoff(attempt);

  yield* Effect.logWarning("Lost the Slack connection, reconnecting").pipe(
    Effect.annotateLogs({
      reason: Schema.is(SlackSocketDropped)(error) ? error.reason : error.reason._tag,
      attempt,
      delayMs: Duration.toMillis(delay),
    }),
  );

  if (attempt === REPORT_AFTER_FAILURES) yield* ErrorReporter.report(Cause.fail(error));

  yield* Effect.sleep(delay);
});

const ack = (writer: Socket.Writer, envelope: Envelope) =>
  Option.match(envelope.envelopeId, {
    onNone: () => Effect.void,
    onSome: (envelopeId) =>
      writer.write(JSON.stringify({ envelope_id: envelopeId })).pipe(Effect.mapError(dropped)),
  });

export class SlackSocket extends Context.Service<
  SlackSocket,
  {
    readonly envelopes: Stream.Stream<Envelope>;
  }
>()("bot/SlackSocket") {
  static readonly layerNoDeps = Layer.effect(
    SlackSocket,
    Effect.gen(function* () {
      const slack = yield* SlackClient;
      const makeWebSocket = yield* Socket.WebSocketConstructor;

      const handle = Effect.fnUntraced(function* (
        frame: string,
        writer: Socket.Writer,
        queue: Queue.Queue<Envelope, Cause.Done>,
      ): Effect.fn.Return<boolean, SlackSocketDropped> {
        const decoded = decodeEnvelope(frame);

        if (Option.isNone(decoded)) {
          yield* Effect.logWarning("Couldn't read a Slack Socket Mode message");

          return false;
        }

        const envelope = decoded.value;

        yield* ack(writer, envelope);

        if (envelope.type === "disconnect") return true;

        if (envelope.retryAttempt > 0) {
          yield* Effect.logDebug("Dropped a redelivered Slack event");

          return false;
        }

        if (Option.isSome(envelope.event)) yield* Queue.offer(queue, envelope);

        return false;
      });

      const session = Effect.fn("SlackSocket.session")(
        function* (queue: Queue.Queue<Envelope, Cause.Done>, failures: Ref.Ref<number>) {
          const url = yield* slack.openConnection;
          const socket = yield* Socket.makeWebSocket(url);
          const pull = yield* Socket.readerString(socket).pipe(Effect.mapError(dropped));
          const writer = yield* socket.writer;

          yield* Effect.logInfo("Connected to Slack");

          while (true) {
            const frames = yield* pull.pipe(Effect.mapError(dropped));

            yield* Ref.set(failures, 0);

            for (const frame of frames) {
              if (yield* handle(frame, writer, queue)) return;
            }
          }
        },
        Effect.scoped,
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
      );

      const envelopes = Stream.callback<Envelope>((queue) =>
        Ref.make(0).pipe(
          Effect.flatMap((failures) =>
            session(queue, failures).pipe(
              Effect.catch((error) => reconnectAfter(error, failures)),
              Effect.forever,
            ),
          ),
        ),
      );

      return SlackSocket.of({ envelopes });
    }),
  );

  static readonly layer = SlackSocket.layerNoDeps.pipe(
    Layer.provide(NodeSocket.layerWebSocketConstructor),
  );
}
