import type { Effect, Option, Stream } from "effect";
import type { Admin } from "recording-requests/Admins";
import type { ErasureCase, RefusalGround } from "recording-requests/Consent";
import type { ErasureNotice, NoticeMedium } from "recording-requests/ConsentRequests";

export type ErasureVerdict =
  | { readonly kind: "now" }
  | { readonly kind: "seen" }
  | { readonly kind: "refuse"; readonly ground: RefusalGround; readonly reason: string };

export interface ErasureAction {
  readonly requestId: number;
  readonly admin: Admin;
  readonly verdict: ErasureVerdict;
  reply(text: string): Effect.Effect<void>;
}

export interface SentNotice {
  readonly channel: string;
  readonly messageId: string;
}

export interface AdminLine {
  readonly medium: NoticeMedium;
  notify(admin: Admin, erasure: ErasureCase): Effect.Effect<Option.Option<SentNotice>>;
  update(notice: ErasureNotice, text: string): Effect.Effect<void>;
  readonly actions: Stream.Stream<ErasureAction>;
}
