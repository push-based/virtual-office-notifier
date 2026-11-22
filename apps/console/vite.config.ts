import { cloudflare } from "@cloudflare/vite-plugin";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";

import { typecheck } from "../../tools/vite-task/typecheck.ts";

export default defineConfig(({ mode }) => ({
  define: {
    __SENTRY_RELEASE__: JSON.stringify(process.env["GITHUB_SHA"] ?? ""),
  },
  plugins: lazyPlugins(() => [
    foldkit({ buildId: process.env["GITHUB_SHA"] ?? "local" }),
    mode === "test" || mode === "prerender" || mode === "fake"
      ? []
      : cloudflare({ viteEnvironment: { name: "worker" } }),
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
      {
        extends: true,
        test: {
          name: "built",
          environment: "node",
          include: ["smoke/**/*.spec.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
  run: {
    tasks: {
      typecheck: typecheck(
        "pnpm -w exec tsc --noEmit -p apps/console && pnpm -w exec tsc --noEmit -p apps/console/worker && pnpm -w exec tsc --noEmit -p apps/console/tsconfig.node.json",
      ),
      build: {
        command: "vp build && node scripts/render-shell.ts",
        cache: {
          input: [
            { auto: true },
            "!node_modules/.vite/**",
            "!node_modules/.render-shell/**",
            "!.wrangler/state/**",
            "!dist/**",
          ],
          output: [
            { auto: true },
            "!node_modules/.vite/**",
            "!node_modules/.render-shell/**",
            "!.wrangler/state/**",
          ],
        },
      },
      test: "vp test --project page --project worker",
      smoke: {
        command: "vp test --project built",
        dependsOn: ["build"],
      },
    },
  },
}));
