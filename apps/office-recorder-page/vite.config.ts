import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [
    ngp({
      typeChecker: "tsrs",
      typeCheck: true,
    }),
  ]),
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
  run: {
    tasks: {
      build: {
        command: "vp build",
        cache: {
          input: [{ auto: true }, "!node_modules/.vite/**"],
          output: [{ auto: true }, "!node_modules/.vite/**"],
        },
      },
      test: "vp test",
    },
  },
});
