import { Effect } from "effect";
import { Server } from "foldkit/experimental";

import { init, view } from "./app/main.ts";

export const renderShell = (template: string): Promise<string> =>
  Effect.runPromise(
    Server.renderToString({ init, view }).pipe(
      Effect.map((application) => Server.injectIntoTemplate(template, application)),
    ),
  );
