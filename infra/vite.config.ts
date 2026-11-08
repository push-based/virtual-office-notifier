import { defineConfig } from "vite-plus";

import { typecheck } from "../tools/vite-task/typecheck.ts";

export default defineConfig({
  run: {
    tasks: {
      typecheck: typecheck(),
      plan: {
        command: "alchemy plan --stage prod --adopt",
        cache: false,
      },
      deploy: {
        command: "alchemy deploy --stage prod --adopt --yes",
        cache: false,
      },
      "admin-plan": {
        command: "scripts/admin.sh plan",
        cache: false,
      },
      "admin-deploy": {
        command: "scripts/admin.sh deploy",
        cache: false,
      },
    },
  },
});
