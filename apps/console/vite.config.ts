import { cloudflare } from "@cloudflare/vite-plugin";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

import { typecheck } from "../../tools/vite-task/typecheck.ts";

export default defineConfig(({ mode }) => ({
  define: {
    __SENTRY_RELEASE__: JSON.stringify(process.env["GITHUB_SHA"] ?? ""),
  },
  plugins: lazyPlugins(() => [
    foldkit(),
    mode === "test" ? [] : cloudflare({ viteEnvironment: { name: "worker" } }),
  ]),
  test: {
    projects: [
      {
        extends: true,
        test: { name: "page", environment: "jsdom", include: ["src/**/*.spec.ts"] },
      },
      {
        extends: true,
        test: { name: "worker", environment: "node", include: ["worker/**/*.spec.ts"] },
      },
    ],
  },
  run: {
    tasks: {
      typecheck: typecheck(
        "pnpm -w exec tsc --noEmit -p apps/console && pnpm -w exec tsc --noEmit -p apps/console/worker",
      ),
      build: {
        command: "vp build",
        cache: {
          input: [{ auto: true }, "!node_modules/.vite/**", "!.wrangler/state/**"],
          output: [{ auto: true }, "!node_modules/.vite/**", "!.wrangler/state/**"],
        },
      },
      test: "vp test",
    },
  },
}));
