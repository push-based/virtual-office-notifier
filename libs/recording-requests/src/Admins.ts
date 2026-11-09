import { Schema } from "effect";

export const Admin = Schema.Struct({
  name: Schema.String,
  discordUserId: Schema.String,
  slackUserId: Schema.NullOr(Schema.String),
});

export type Admin = typeof Admin.Type;
