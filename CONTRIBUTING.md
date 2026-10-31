# Contributing

Thanks for helping out. The process here is light, but every merge into `main` deploys straight to production, so a pull request has to be ready to ship.

- [Before you start](#before-you-start)
- [Setting up](#setting-up)
- [Making a change](#making-a-change)
- [Checks](#checks)
- [Toolchain](#toolchain)
- [Commits and pull requests](#commits-and-pull-requests)
- [Deploys](#deploys)
- [License](#license)

## Before you start

For anything bigger than a small fix, open an issue first so we can agree on the approach before you put time into it. This posts to a shared Slack channel, so changes to what it says, or when, affect everyone in it.

Found a security problem? Don't open an issue. Follow [SECURITY.md](SECURITY.md) instead.

## Setting up

You'll need Node 26 (see `.nvmrc`) and pnpm. The pnpm version is pinned in `package.json`, and `corepack enable` picks it up.

```bash
pnpm install
cp .env.example .env
```

Most changes don't need a `.env` at all, since the tests run without tokens or network access. To try a change for real, fill in `.env` with your own Discord bot, test server and Slack app. [Setting it up](docs/setup.md) covers creating those.

> [!WARNING]
> Never point a local run at the production Discord or Slack tokens. Two copies watching the same channel post every announcement twice.

## Making a change

- Branch off `main`, and keep a pull request to one change. Unrelated cleanups go in their own.
- Add or update tests for any change in behaviour.
- Update the [docs](docs) when you change what gets posted, the configuration, the Console or the deploy, and the [README](README.md) when a feature is added or removed.

### Code style

The app is built on [Effect](https://effect.website) v4. Follow the patterns already in `apps/bot/src/`:

- Services are `Context.Service` classes with a `layer`, and a test layer where tests need one.
- The bot's code sits in a folder per concern under `apps/bot/src/`, and each folder's `index.ts` is its interface. Code outside a folder imports only its `index.ts`, and lint fails on anything deeper. Tests mirror the folders and can import the internals.
- Errors are `Schema.TaggedError` classes, handled by tag.
- Configuration is read through `Config` in [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts). Secrets are `Redacted` and never logged. Watch out for errors that carry request headers, since the Slack and Cloudflare tokens travel in them.
- Anything posted to Slack that comes from outside, like a Discord display name or AI output, goes through `escapeSlackText`, so it can't ping `@channel` or post links.
- Names are never sent to the AI providers.
- A failure worth an alert is reported to Sentry with `Effect.withErrorReporting` or `ErrorReporter.report`, before it's caught. Set its severity with `[ErrorReporter.severity]`.
- Comments explain why, not what.

`pnpm vp run check` checks formatting with Oxfmt and lints with Oxlint and the vendored [anti-slop](tools/oxlint/anti-slop/UPSTREAM.md) rules, both configured in the root [`vite.config.ts`](vite.config.ts). `pnpm vp check --fix` formats every file and applies the lint fixes it can. In VS Code, the recommended Vite+ extension pack formats on save with the same config. The pre-commit hook that `pnpm install` sets up runs `vp check --fix` on what you stage, so a commit is already formatted. `VP_GIT_HOOKS=0 git commit` skips it once.

The one-off reformat that turned Oxfmt on is listed in [`.git-blame-ignore-revs`](.git-blame-ignore-revs). GitHub skips it in blame views, and `git config blame.ignoreRevsFile .git-blame-ignore-revs` makes your local `git blame` skip it too.

### Tests

The bot's tests live in `apps/bot/test/` and use [`@effect/vitest`](https://www.npmjs.com/package/@effect/vitest). They swap in fakes through layers rather than mocking modules, which the linter rejects:

- [`apps/bot/test/fakes.ts`](apps/bot/test/fakes.ts) has a fake Slack Web API that serves scripted replies and records every request, in-memory Slack, history and Clef stand-ins for the responder, and a helper that pins the random phrasing so tests can assert the exact text.
- `DiscordGateway.layerTest` feeds voice-state updates from a queue through the same occupancy tracking the real gateway uses.
- `HeadlineWriter.layerProviders` takes fake language models, so the provider fallback can be tested without calling a real one.
- Database code runs against [PGlite](https://pglite.dev), an in-process Postgres, with the real migrations. Give it `columnNaming` from `apps/bot/src/database/Database.ts` so column names convert the same way as in production. `apps/bot/test/fakes.ts` also has a fake recorder for program tests.

### Adding a configuration variable

A new environment variable has to be wired through in several places, or production won't get it:

1. Read it in [`apps/bot/src/Config.ts`](apps/bot/src/Config.ts).
2. Add it to [`.env.example`](.env.example).
3. Add it to the configuration table in [docs/setup.md](docs/setup.md#configuration).
4. Pass the secret to the deploy step in [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
5. Write it to the env file in [`apps/bot/scripts/deploy.ts`](apps/bot/scripts/deploy.ts).

I add the matching GitHub secret before merging.

## Checks

CI runs one task on every pull request and every push to `main`. Run it before you push:

```bash
pnpm vp run ci
```

It typechecks, checks formatting and lint, tests and builds every package, and dry-runs the Console's deploy. It's defined in the root [`vite.config.ts`](vite.config.ts), and tasks whose inputs haven't changed replay from the cache. A newer push to a pull request cancels the run before it. CI sets up Node, pnpm and `vp` with [`setup-vp`](https://github.com/voidzero-dev/setup-vp), and keeps the task cache between runs, including the tasks that passed in a failed run. Dependabot keeps the pinned actions up to date.

The pieces, which you can run on their own:

| Command                     | What it does                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm vp run -r typecheck`  | Type-check every package with TypeScript 7.                                                                                                                                                                                                            |
| `pnpm vp run check`         | Check formatting with Oxfmt and lint with Oxlint, across the whole repo, with the `fmt` and `lint` config in the root `vite.config.ts`. Lint includes the Effect rules. `pnpm vp check --fix` formats every file and applies the automatic lint fixes. |
| `pnpm vp run -r test`       | Run every package's tests with Vitest.                                                                                                                                                                                                                 |
| `pnpm vp run -r build`      | Bundle the bot to `apps/bot/dist/main.js` with a source map, and build the Console to `apps/console/dist`: the page in `client/`, type-checked on the way, and the Worker with its generated `wrangler.json` in `worker/`.                             |
| `pnpm vp run console#check` | Build the Console and run `wrangler deploy --dry-run` on the result.                                                                                                                                                                                   |
| `pnpm --filter bot dev`     | Run the bot from source with `.env`.                                                                                                                                                                                                                   |
| `pnpm --filter bot start`   | Run the bot's bundle with `.env`.                                                                                                                                                                                                                      |
| `pnpm --filter console dev` | Serve the Console's page with live reload and run its Worker in the Workers runtime on the same origin. See [Toolchain](#toolchain) for the database it needs.                                                                                         |

Run a single package's task with `pnpm vp run <package>#<task>`, for example `pnpm vp run bot#test`. `pnpm vp cache clean` clears the task cache.

## Toolchain

The workspace runs on [Vite+](https://viteplus.dev). Each package defines its tasks in its `vite.config.ts`, and `vp run` runs them in dependency order and caches the results, so a task whose inputs haven't changed replays instead of running again. `pnpm vp` runs the local copy if you don't have `vp` installed globally.

Lint is type-aware (`lint.options.typeAware`), so rules that need types run too, including the Effect rules. Those come from [`@effect/tsgo`](https://github.com/Effect-TS/tsgo): the `prepare` script swaps the Oxlint and `tsgolint` that Vite+ brings in for its Effect-patched builds, and leaves TypeScript as it is. It only supports exact Oxlint and `oxlint-tsgolint` versions, so upgrade `vite-plus` and `@effect/tsgo` together.

Every Effect rule is an error for the bot, the Worker, `activity-sign-in` and `recording-requests`, so `vp check` fails on any of them, including the rules that are only suggestions by default. Fix the code rather than silencing a rule. The patched `tsgolint` reads its options from the `@effect/language-service` entry in the root [`tsconfig.json`](tsconfig.json), which lists the unstable Effect modules the app is allowed to use in `allowedUnstableApis`, so using a new one means adding it there.

Vite, Vitest, Oxlint and Oxfmt come from Vite+. The catalog in [`pnpm-workspace.yaml`](pnpm-workspace.yaml) points `vite` at Vite+'s core, and its overrides keep a single copy of Vite and Vitest across the workspace, which `@effect/vitest` needs to register its tests with the runner `vp test` starts. Upgrade them by bumping `vite-plus` and `vitest` there together.

The Console's page and the design system are compiled by [vite-plugin-ngp](https://push-based.github.io/vite-plugin-ngp/getting-started). The plugin only works with the Angular release its compiler was built from, so every `@angular/*` package is pinned to exactly that version in the `angular` catalog in [`pnpm-workspace.yaml`](pnpm-workspace.yaml), with the plugin and the TypeScript 6 that Angular's compiler needs. Upgrade them together there. The Console's Worker is type-checked with the root's TypeScript 7 instead, from its own [`tsconfig.json`](apps/console/worker/tsconfig.json), and ngp only compiles the browser build, not the Worker.

Running the Console locally needs a Postgres for its `DATABASE` Hyperdrive binding, with a password in the URL, even if you never record. Set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DATABASE`, for example to `postgres://postgres:postgres@localhost:5432/postgres` (the `console` preview in [`.claude/launch.json`](.claude/launch.json) uses that), and put the Worker's secrets in `apps/console/.dev.vars`.

The lint rules in `tools/oxlint/anti-slop` are vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop). [`UPSTREAM.md`](tools/oxlint/anti-slop/UPSTREAM.md) records the commit they were copied from.

## Commits and pull requests

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) with a short lowercase summary, like `feat: fall back to Cloudflare Workers AI for headlines`. Use `feat`, `fix`, `docs`, `test`, `refactor`, `ci` or `chore`.
- Pull requests are squash-merged, so the title becomes the commit summary. Use the same format for it.
- Explain why in the description, not just what changed, and say how you tested it. The pull request template has the checklist.

## Deploys

Merging into `main` deploys to production, and that's the only way anything gets deployed. There are no manual deploys. If a deploy fails, the job prints the service's last log lines. Fix it, or revert it, with a new pull request.

## License

By contributing, you agree that your contributions are licensed under the [0BSD license](LICENSE), like the rest of the project.
