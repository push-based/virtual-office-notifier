import { cloudflare } from "@cloudflare/vite-plugin";
import { ngp } from "@push-based/vite-plugin-ngp";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";

const inTheBrowser = (plugins: ReadonlyArray<Plugin>): Array<Plugin> =>
  plugins.map((plugin) => ({
    ...plugin,
    applyToEnvironment: (environment) => environment.config.consumer === "client",
  }));

export default defineConfig(({ mode }) => ({
  plugins: lazyPlugins(() =>
    mode === "test"
      ? ngp()
      : [
          ...inTheBrowser(ngp({ typeChecker: "tsrs", typeCheck: true })),
          ...cloudflare({ viteEnvironment: { name: "worker" } }),
        ],
  ),
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
  run: {
    tasks: {
      typecheck: "pnpm -w exec tsc --noEmit -p apps/office-recorder/worker",
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
