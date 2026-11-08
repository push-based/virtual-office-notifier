import { defineConfig } from "vite-plus";

import { typecheck } from "../../tools/vite-task/typecheck.ts";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
      typecheck: typecheck(),
      test: "vp test",
    },
  },
});
