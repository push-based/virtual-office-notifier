const workspace = (pattern: string) => ({ pattern, base: "workspace" as const });

export const typecheck = (command = "tsc --noEmit") => ({
  command,
  cache: {
    input: [
      { auto: true },
      "**/*.ts",
      "**/*.json",
      "!node_modules/**",
      "!dist/**",
      "!.wrangler/**",
      workspace("tsconfig.json"),
      workspace("pnpm-lock.yaml"),
      workspace("libs/*/src/**"),
      workspace("libs/*/package.json"),
    ],
  },
});
