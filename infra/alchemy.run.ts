import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stack } from "alchemy";
import { Effect } from "effect";

export default Stack(
  "virtual-office",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.succeed({}),
);
