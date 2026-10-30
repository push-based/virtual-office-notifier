import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [ngp()]),
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
  run: {
    tasks: {
      test: "vp test",
    },
  },
});
