import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
      check: {
        command: "wrangler deploy --dry-run --outdir dist",
        dependsOn: ["office-recorder-page#build"],
        cache: {
          input: [{ auto: true }, "!dist/**", "!.wrangler/**"],
          output: [],
        },
      },
      deploy: {
        command: "wrangler deploy",
        cache: false,
        dependsOn: ["office-recorder-page#build"],
      },
    },
  },
});
