import { Runtime } from "foldkit";

import { init, Model, subscriptions, update, view } from "./app/main.ts";
import { resources } from "./app/resources.ts";
import { reportCrash } from "./app/telemetry/telemetry.ts";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources,
  container: document.getElementById("root"),
  crash: { report: ({ error }) => reportCrash(error) },
});

if (import.meta.env.DEV) {
  Runtime.run(application);
} else {
  Runtime.hydrate(application);
}
