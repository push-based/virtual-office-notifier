import { cloudflare } from "@cloudflare/vite-plugin";
import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";

const onlyInTheBrowser = (plugin: Plugin): Plugin => ({
  ...plugin,
  applyToEnvironment: (environment) => environment.config.consumer === "client",
});

export default defineConfig(({ mode }) => ({
  plugins: lazyPlugins(() => [
    ngp({ typeChecker: "tsrs" }).map(onlyInTheBrowser),
    mode === "test" ? [] : cloudflare({ viteEnvironment: { name: "worker" } }),
  ]),
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "page",
          environment: "jsdom",
          include: ["src/**/*.spec.ts"],
          setupFiles: ["src/test-setup.ts"],
        },
      },
      {
        extends: true,
        test: { name: "worker", environment: "node", include: ["worker/**/*.spec.ts"] },
      },
    ],
  },
  run: {
    tasks: {
      typecheck: "pnpm -w exec tsc --noEmit -p apps/console/worker",
      build: {
        command: "vp build",
        cache: {
          input: [{ auto: true }, "!node_modules/.vite/**", "!.wrangler/state/**"],
          output: [{ auto: true }, "!node_modules/.vite/**", "!.wrangler/state/**"],
        },
      },
      test: "vp test",
      check: {
        command: "wrangler deploy --dry-run",
        dependsOn: ["build"],
        cache: {
          input: [{ auto: true }, "!.wrangler/tmp/**"],
          output: [],
        },
      },
      deploy: {
        command: "wrangler deploy",
        cache: false,
        dependsOn: ["build"],
      },
    },
  },
}));
