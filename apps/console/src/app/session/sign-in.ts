import { Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

export const SignIn = defineTaggedUnion({
  SigningIn: {},
  SignedIn: {},
  FailedSignIn: { reason: Schema.String },
});

export type SignIn = typeof SignIn.Type;
