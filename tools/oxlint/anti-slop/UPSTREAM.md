# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied from: `skills/install-anti-slop/assets/anti-slop/` (identical to upstream `src/` at that commit, minus `*.test.ts`)
- Installed paths:
  - `tools/oxlint/anti-slop/index.ts` (generic plugin, registered as `anti-slop`)
  - `tools/oxlint/anti-slop/effect/index.ts` (Effect plugin, registered as `anti-slop-effect`)
- Oxlint: the copy bundled with `vite-plus` (`oxlint@1.89.0`, `@oxlint/plugins@1.89.0`)
- Local deviations:
  - Imports `vite-plus/lint/plugins` instead of `@oxlint/plugins`, so the rules use the plugin API of the Oxlint that `vp lint` runs.
  - `no-module-mocking` also recognises `vi` imported from `vite-plus/test`.
