import { defineConfig } from "rolldown";

export default defineConfig({
  input: "activity/client/main.ts",
  platform: "browser",
  output: {
    file: "activity/public/main.js",
    format: "esm",
    sourcemap: true,
    codeSplitting: false,
  },
});
