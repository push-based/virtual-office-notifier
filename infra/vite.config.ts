import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
      deploy: {
        command: "alchemy deploy --stage prod --yes",
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
