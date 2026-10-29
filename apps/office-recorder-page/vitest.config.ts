import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [ngp()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
