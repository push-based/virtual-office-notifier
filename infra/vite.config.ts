import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
      deploy: {
        command: "alchemy deploy --stage prod --yes",
        cache: false,
      },
    },
  },
});
