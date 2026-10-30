import { defineConfig } from "vite-plus";

export default defineConfig({
  publicDir: false,
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "src/main.ts",
    target: "node26",
    sourcemap: true,
    rolldownOptions: {
      external: ["zlib-sync", "bufferutil", "utf-8-validate", "@snazzah/davey"],
      output: {
        entryFileNames: "main.js",
        codeSplitting: false,
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
  run: {
    tasks: {
      typecheck: "tsc --noEmit",
      test: "vp test",
      build: "vp build",
      deploy: {
        command: "node scripts/deploy.ts",
        cache: false,
        dependsOn: ["build"],
      },
    },
  },
});
