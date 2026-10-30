import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
      test: "vp test",
    },
  },
});
