import { defineConfig } from "vite-plus";

import { typecheck } from "../../tools/vite-task/typecheck.ts";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
  },
  run: {
    tasks: {
      typecheck: typecheck(),
      test: "vp test",
    },
  },
});
