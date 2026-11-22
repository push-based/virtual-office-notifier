# design-system

The Console's UI package. It holds the Foldkit view helpers the page builds its markup from, and the design tokens and CSS that give that markup its look. The interactive helpers sit on [`@foldkit/ui`](https://foldkit.dev/ui/overview), Foldkit's headless components, so the ARIA attributes, keyboard handling and focus management come from there and the markup and styling come from here.

Every helper takes the page's `HtmlBuilder` first and a config second, and returns `Html`:

```ts
import { button, card, eyebrow } from "design-system";

card(h, "lg", [
  eyebrow(h, { text: "Recording" }),
  button(h, { label: ["Pause"], variant: "ghost", onClick: Message.ClickedPause() }),
]);
```

## CSS

The package exports four stylesheets:

| File             | What it holds                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `tokens.css`     | The design tokens (colours, spacing, radii, shadows, fonts) as custom properties, and the text styles. |
| `components.css` | The styles for the helpers' markup, all under `pb-` class names.                                       |
| `utilities.css`  | Layout and text utilities the page can put on its own elements.                                        |
| `styles.css`     | The Geist fonts, then the three files above, in that order.                                            |

The page imports `styles.css` once, at the top of [`apps/console/src/styles.css`](../../apps/console/src/styles.css), and adds its own layout after it:

```css
@import "design-system/styles.css";
```

The utilities the page can use as class names are:

- the text styles, like `text-body`, `text-body-sm`, `text-caption` and `text-section-title`, and `text-tabular` for numbers that line up;
- `sr-only`, for text only screen readers read;
- `stack-2`, a column with a small gap;
- `align-start`, which keeps an item at the start of a flex column instead of stretching it;
- `label`, a bold heading-coloured line, and `muted`, muted text inside one;
- `confirm` and `confirm-danger`, the bordered box that asks someone to confirm, and its red variant.

## Helpers

| Helper            | What it renders                                                                                                  | Built on            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------- |
| `avatar`          | A person's picture, or their initials when there's none.                                                         |                     |
| `badge`           | A small coloured label for a state, like Live or Done.                                                           |                     |
| `barList`         | A labelled list of values, each with a bar sized against the largest.                                            |                     |
| `barShare`        | The width, in percent, `barList` gives one bar.                                                                  |                     |
| `blockButton`     | A whole block of content that acts as one button, styled by a class the page passes.                             | `Button`            |
| `button`          | A button in the primary, ghost or tertiary style.                                                                | `Button`            |
| `card`            | The bordered panel the page's sections sit in.                                                                   |                     |
| `checkbox`        | A native checkbox. Name it with `checkboxLabel`, so the visible text is its label and clicking it ticks the box. |                     |
| `checkboxLabel`   | The visible label for a `checkbox`, tied to it by id.                                                            |                     |
| `description`     | A paragraph of muted secondary text.                                                                             |                     |
| `descriptionItem` | The same muted text as a list item, for a list that has nothing in it.                                           |                     |
| `disclosure`      | A button that shows and hides the content under it.                                                              | `Disclosure`        |
| `divider`         | A horizontal rule.                                                                                               |                     |
| `eyebrow`         | The small heading above a section.                                                                               |                     |
| `heading`         | A section title.                                                                                                 |                     |
| `heatmap`         | A labelled table of cells shaded by value, each described for screen readers.                                    |                     |
| `heatOf`          | The shade, from 0 to 1, `heatmap` gives one cell.                                                                |                     |
| `initials`        | The first letters of someone's first two names.                                                                  |                     |
| `inlineSelect`    | A compact select that sits in a line of content, named by a label only screen readers see.                       | `Select`            |
| `liveDot`         | The pulsing red dot that says something is live.                                                                 |                     |
| `notice`          | An info or error message.                                                                                        |                     |
| `noticeRegion`    | The status region notices go in, so screen readers announce them.                                                |                     |
| `people`          | A labelled row of avatars.                                                                                       |                     |
| `selectField`     | A labelled select.                                                                                               | `Select`            |
| `stat`            | A number with a caption under it.                                                                                |                     |
| `statusHeading`   | A heading with an optional live dot, subheading and description.                                                 |                     |
| `Tabs`            | A tab list and its panels. A Submodel, see below.                                                                | `Tabs`              |
| `textField`       | A labelled text input, or a textarea with `isMultiline`, with a character count when it has a `maxLength`.       | `Input`, `Textarea` |

`Content` is the type of a helper's children: `Html` or a string.

## Tabs

`Tabs` is the one helper with state of its own. `@foldkit/ui` keeps track of which tab has keyboard focus, moves focus with the arrow keys, Home and End, and selects the focused tab. The page keeps which tab is selected. Wire it in like any other Submodel:

- a `Tabs.Model` field in the page's Model, made with `Tabs.init(name)`;
- a `Got…Message` that carries a `Tabs.Message`;
- an `Update.foldChild` with `Tabs.update`, whose `foldOutMessage` handles `Selected` by storing the tab's value;
- `Tabs.view(h, config)` in the view.

`Tabs.view` renders the tab list and hands it to the page's `toView`, together with a `panel` function. The page lays them out, and renders each tab's content through `panel(id, attributes, children)`, which labels the panel with its tab and keeps it out of the tab order. [`apps/console/src/app/main.ts`](../../apps/console/src/app/main.ts) and [`apps/console/src/app/stats/stats.ts`](../../apps/console/src/app/stats/stats.ts) show both.

Clicking a tab, or moving to it with a key, returns a `Tabs.FocusTab` Command. A Scene or Story that selects a tab resolves it with `Tabs.Message.CompletedFocusTab()`.

## Using it from the page

The page builds its markup from these helpers and doesn't write the `pb-` class names itself. Those belong to the helpers and can change with them. When the page needs something the helpers don't offer, add a helper here, with a test in `src/*.spec.ts`, rather than reaching for the class. The page's own layout, like the recording page or the stats panels, stays in the page's stylesheet under its own class names, and a helper that takes a `className`, like `button` or `blockButton`, puts that class next to its own.

The package depends on `foldkit` and `@foldkit/ui` as peer dependencies, from the catalog in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), so the Console installs them once and the helpers share its copy. `vp test` here runs the helpers' Scene tests in jsdom.
