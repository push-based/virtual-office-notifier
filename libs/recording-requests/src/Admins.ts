import { Array, Option } from "effect";

export interface Admin {
  readonly name: string;
  readonly discordUserId: string;
  readonly slackUserId: string;
}

export const ADMINS: ReadonlyArray<Admin> = [
  { name: "Christopher Holder", discordUserId: "553340374836314142", slackUserId: "U03PVMGCJNP" },
  { name: "Julian Jandl", discordUserId: "757606441010855957", slackUserId: "U01UR2HS2TH" },
];

export const adminByDiscordId = (userId: string): Option.Option<Admin> =>
  Array.findFirst(ADMINS, (admin) => admin.discordUserId === userId);

export const adminBySlackId = (userId: string): Option.Option<Admin> =>
  Array.findFirst(ADMINS, (admin) => admin.slackUserId === userId);

export const isAdmin = (discordUserId: string): boolean =>
  Option.isSome(adminByDiscordId(discordUserId));
