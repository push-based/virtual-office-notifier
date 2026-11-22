import { Runtime } from "foldkit";
import { Server } from "foldkit/experimental";

import { init, Message, Model, subscriptions, update, view } from "./app/main.ts";
import { resources as liveResources } from "./app/resources.ts";
import { reportCrash } from "./app/telemetry/telemetry.ts";

const resources =
  import.meta.env.MODE === "fake"
    ? await import("./app/dev/fake-office.ts").then(({ fakeOfficeResources, scenarioOf }) =>
        fakeOfficeResources(scenarioOf(location.search)),
      )
    : liveResources;

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources,
  container: document.getElementById("root"),
  crash: { report: ({ error }) => reportCrash(error) },
  devTools: { Message },
});

if (document.querySelector(`[${Server.FOLDKIT_APP_ATTRIBUTE}]`) === null) {
  Runtime.run(application);
} else {
  Runtime.hydrate(application);
}
