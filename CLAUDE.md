# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Learning more about Foldkit

The Console's page (`apps/console/src`) and the design system
(`libs/design-system`) are built with Foldkit, an Elm-architecture framework on
Effect.

Before writing any Foldkit code, run `pnpm foldkit:vendor`. It puts the Foldkit
repository, at the release the Console installs, in `repos/foldkit/`. Read
`repos/foldkit/AGENTS.md`, then look for a precedent in `repos/foldkit/examples/`
before writing a Model, a Command, a Subscription or a Submodel. Treat
`repos/foldkit/` as read-only reference: imports still come from the installed
`foldkit` package.

The project enables the `foldkit-skills` plugin in `.claude/settings.json`. Use
its `foldkit` skill for any change to the page, and its `audit-program` skill
to review one. The docs are also at https://foldkit.dev/llms.txt.

# No code comments

Don't add comments in productions code. The code must be self documenting.

Additional required information should be documented in the test cases or in proper docs.
