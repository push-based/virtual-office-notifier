import { Schema } from "effect";

export const Notice = Schema.Struct({
  kind: Schema.Literals(["info", "error"]),
  text: Schema.String,
});

export type Notice = typeof Notice.Type;
