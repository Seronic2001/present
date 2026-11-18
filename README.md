# Present

Animated slides that AI agents can build, see and fix. A deck is a folder of plain text. It exports to one self-contained HTML file.

Present has two faces over the same deck folder:

- **The tools layer** (`packages/mcp`): an MCP server that Claude Code, Codex and OpenCode use to read, edit, see and check a deck.
- **The desktop app** (`packages/desktop`): a live preview of those changes, with chat, direct editing, and a show that runs across your screens with a presenter view.

The folder is the only link between them. The MCP server writes to it, the app watches it, so an agent in a terminal and the app's own chat look the same to the preview.

The core rule: a frame is a pure function, `render(document, slide, step, t) → pixels`. Any moment of any animation can be reproduced, so an agent can look at it and a test can check it.

## Quick start

Needs Node 24 (it runs the TypeScript directly) and Chrome or Edge.

```sh
npm install
node packages/cli/src/bin.ts dev examples/launch-story     # open the URL, press I for Studio
```

Or open the Studio app, which brings the preview, your source material and an agent together:

```sh
node packages/cli/src/bin.ts studio examples/launch-story
```

Start your own deck, then point an agent at it:

```sh
node packages/cli/src/bin.ts init my-talk      # writes .mcp.json, AGENTS.md and a Claude Code skill
node packages/cli/src/bin.ts connect my-talk   # also registers the server with Codex
npm run desktop -- my-talk                     # open the live preview
cd my-talk && claude                           # or codex: the agent has the present MCP tools
```

`connect` adds one entry to your Claude Code and Codex user settings. It names no deck: it serves whichever folder the agent starts in. A new deck also has its own `.mcp.json`, which Claude Code asks you to approve the first time. In the app, the same step is File > Connect Claude Code and Codex.

## Two ways to work

**From a finished project.** Run `present connect` once. It adds Present to your Claude Code and Codex user settings, so they have the tools in any folder. Then start either one in the project and ask for a deck. The agent reads your evals and data, creates a deck in `presentation/` with `deck_create`, and writes its plan. Open that folder in the app to review the plan and watch the slides arrive.

**From the app.** Open or create a deck, drop your files into Sources, and ask the built-in agent to plan a deck from them.

## The plan

Before building, an agent shows how it will build the deck: the story, and for each slide its claim, what is on screen, its animation beats and the evidence behind it. It lives in `plan.yaml`, so it is plain text you can read and keep.

In a terminal, `plan_write` returns the plan as text. In Studio, a new plan opens by itself; review it there and comment on any slide. Approving or commenting reaches the built-in agent at once. An agent in a terminal sees it on its next `plan_read`, so tell it to continue.

Every plan is checked. An unknown pattern or library item is refused. A number with no evidence, a missing reference, or more slides than the time allows is flagged. Each planned slide then shows whether it is to build, built, or has errors. Agents are told to wait for approval unless you tell them to go straight on; nothing enforces that.

## Commands

```
present init [dir]                          new deck
present connect [dir]                       give Claude Code and Codex the tools in any folder
present studio [dir] [--port 4173] [--no-open]   Studio app
present dev [dir] [--port 4173]             live preview with Studio
present check [dir] [--static]              diagnostics
present outline [dir]                       structure, timing, revision
present render <dir> <slide> [--step n] [--t ms] [--out f.png]
present filmstrip <dir> <slide> <step> [--columns n]   contact sheet of one step over time
present sheet <dir> [--out f.png] [--columns n] [--changed]   every slide on one image
present export <dir> html|pdf|png|pptx <out> [--steps]
present apply <dir> <ops.json>              run a batch of ops
present undo <dir>                          roll back the last change, however it was made
present upgrade <dir> [--dry-run]           bring an older deck up to date
present mcp [dir]                           MCP server on stdio (the folder Codex or Claude started in, by default)
```

## A slide

The body is the **finished drawing**. The Score only subtracts from it and plays it back, so PDF, overview and still mode need no animation code.

```yaml
---
title: Why agent slides fail
brief: The one real cause is revealed after three guesses are struck out.
notes: Speaker notes.
score:
  intro:
    - rise: [wrong, right]
      stagger: 100
  steps:
    - name: strike the guesses
      each: .guess
      stagger: 180
      cues:
        - draw: $ .strike
        - pop: $ .badge
          at: 160
      loop:
        every: 6000
        cues:
          - travel: link-a
  spots:
    cause:
      cues:
        - type: cause-text
---
<Header>Agents lack <em>eyes</em></Header>
<Diagram viewBox="0 0 1600 600" alt="What the diagram shows">
  <Box id="cause" x="782" y="96" w="766" h="120" tone="accent" spot="" />
  <Link id="link-a" from="cause" to="see" />
</Diagram>
```

Three levels of power: layout macros (`Header`, `Columns`, `Card`, `Stat`, `Code`), `<Diagram>` for dense drawings with raw SVG allowed, and code in `scenes/*.ts`, `tracks/*.ts` and `macros/*.ts` for what the Score cannot express. `present mcp`'s `catalog` tool lists everything with examples, and `writingMacros` in it gives the macro file format.

Formulas use `<Math>` with LaTeX, typeset at build time by KaTeX. Its fonts go inside the deck, only when the deck has a formula, so they look the same on every machine. `<TextBlock>` is text that wraps in a Diagram. Attributes like `fill` and `font-family` on SVG `<text>` are moved to inline style so they beat the theme. Colour that is content uses `data-1` to `data-6`, which `theme.yaml` can override. `align: top` in `deck.yaml` pins headers, and a slide can opt out with `align: center`.

`act="name"` makes any part a click target that plays the cues under `score.actions.name`, in any order and at any step, with no scripts: `toggle` lets a second click reverse it, and `group` makes actions pick-one. In a show they start unplayed; checks and PDFs see the finished drawing. The `leave` cue takes something away and keeps it gone. A part that ends gone is skipped by the rendered checks, so what replaces it can share its place. `goto="slide-id"` makes a part a click target, and pointing choices at deep dives lets the room pick a branch. `<Embed src="page.html">` puts a self-contained page of your own on a slide, in a sandbox: its scripts run, but it cannot reach the deck. It runs in the presenter view too: a click in either copy reaches both, with the same random numbers, so you can drive it from your own screen, and `goto` targets work from there as well. Typing and timers are not shared.

A custom track default-exports `(el, args, api) => apply(p)`. `apply` must depend only on `p`, and `p=0` and `p=1` must leave the drawing as it was when used in a loop.

### Scenes

For choreography cues cannot express (a spark riding a stroke as it draws, a dot that stops at a gate, loops at several rates, cause and effect across a whole figure), a slide can be driven by a scene: `scenes/<name>.ts` default-exports `(ctx) => { ... }`, and the slide says `score: { scene: <name> }`. The scene owns the slide's first `<svg>` (or `score.root`). Its body is the intro, each `ctx.step(name, fn)` is a click, and loops started with `ctx.every` or `ctx.frame` run while the presenter talks, then stop after the rest window and `ctx.onRest` settles the drawing. The helpers (`tween`, `reveal`, `pop`, `draw` with a spark, `type`, `count`, `travel`, `ripple`, `hot`, `dot`, `layer`, `along`, `center`, `rand`) are documented with examples under `scenes` in the catalog.

A scene is imperative, so it is made a function of time by replay: it runs on a virtual clock, and going back restores the drawing and runs it again up to that moment. The same replay measures each step, so a score never carries durations. The page measures as it mounts a slide, and `deck_apply` and `deck_check` record the timings in `.present/scenes.json` so the outline and the presenter know them without a browser. `slide_filmstrip` with `loop: true` films what moves after the build.

## Building with primitives

Four layers, smallest to largest, and an agent gets all of them from the `catalog` tool. They were found by measuring a real 14-slide talk: what it drew and animated again and again.

- **Cues** move one thing. `animate` moves any number in an attribute or style, and carries on from where it last stopped, and `stream` sends many particles along a path. Two cues work on a whole structure: `build` brings a Diagram in by its links (boxes nothing points at pop first, then each link draws and a particle lands its target), and `swap` shows one panel of a `<Swap>` in place of another. `type` keeps tspans, so coloured code types in colour, and `count` counts the first number in any text.
- **Phrases** are named runs of cues: `arrive`, `appear`, `strike`, `handoff`, `verdict`, `flood`, `survey`, `type-code`. Add your own under `phrases:` in `deck.yaml`.
- **Figures** are drawings: `Milestones`, `Plot`, `Timing`, `Hub`, `Terrain`, `Neck`. Each repeated unit is a `.part` holding `.seg`, `.node` and `.body`, so one phrase moves them all.
- **Patterns** are whole slides for a job: `statement`, `agenda`, `contrast`, `flow`, `evidence`, `breakdown`, `boundary`, `gates`, `search`. Open `examples/patterns` to see them; `node scripts/gallery.ts` regenerates it.

A step per part takes one line:

```yaml
score:
  steps:
    - over: .part
      use: arrive
```

An agent adds a pattern with `addSlide{id, pattern}`, or reads one with `pattern_read` to adapt it. A beat written twice becomes a phrase, and a drawing made twice becomes a macro in `macros/`.

## The library

Components saved across projects, in the spirit of shadcn: adding one copies its source into your deck, so the deck owns it and has no dependency. The library is a plain folder, `~/.present/library` (`PRESENT_LIBRARY` moves it), so you can read it, edit it, or keep it in git. An item can hold a slide, macros, tracks, scenes, phrases and styles together. `library_search` finds one by what it is for, in plain words.

It fills itself. After each `deck_apply`, the MCP server saves the phrases, macros, tracks and scenes the deck defined, and agents are told to save slides worth reusing with `library_save`, without asking. Agents see the library in `catalog` and copy from it with `library_add`.

Saving a slide gathers what it depends on. Whole slides are only saved by an agent's choice, because they hold content. Agents are told to save the form and not the facts, but that is an instruction, not a guarantee.

- Macros, tracks and scenes are code. Items holding them are marked `code`, with the deck they came from. Read one from a deck you do not recognise before using it.
- Put `library: false` in `deck.yaml` for a deck whose work must stay private. Do this for client work.
- Files over 64 KB are not harvested. A replaced item is kept in `.replaced/`.

`present library` lists it, `present library add <name> [dir]` copies one in, and `present library remove <name>` deletes one.

## Deep dives

A deck is a tree. The main path is the talk, and any slide can have deep dives under it, which can have their own. You choose in the room how far to go, by the time left or what the audience asks.

```yaml
slides:
  - 01-title
  - id: results
    deep:
      - method
      - id: per-subsystem
        deep:
          - retrieval
  - close
```

`↓` or `D` dives in, and `↑` or `U` comes back. `→` stays on the path you are on: at the end of a dive it returns to the parent slide, fully built, and the next press carries on with the main path. So a dive you skip costs nothing, and a dive you take cannot lose your place.

Slides are numbered by position, like 5 and 5.2, and the count is the main path. The presenter view shows what you can dive into, where you are and the way back. Timing counts the main path, and `deck_outline` reports the deep dives separately. Agents build trees with `addSlide{under}` and `moveSlide`, and plans give a slide `under`. HTML, PDF and PPTX exports include every slide, in tree order.

## Studio app

`present studio` opens the deck in an app window. In the desktop app, the menu is behind the button at the top left. Everything you collect is attached to your next message.

- **Select** (`V`): click parts of a slide. The agent gets their ids.
- **Circle** (`C`): draw a loop. The agent gets a marked screenshot and the ids inside it.
- **Screenshot** (`S`): the exact frame on screen, rendered at 1920×1080.
- **Capture window**: pick any window or screen, then circle the part you want.
- **References**: drop files anywhere, or paste an image. They are stored in the deck's `references/` folder, and agents read them with `references_list` and `reference_read`. PDF, DOCX, Markdown, CSV, JSON and other text are read as text; images as images. Excel files and scanned PDFs are not: export to CSV or take screenshots.
- **Export**: HTML, PDF, PDF with a page per step, or PowerPoint, from the button in the title bar. PowerPoint is one picture per slide with its notes, so it looks right but its text is not editable.
- **Problems**: click an error badge, or the count in the status bar, to read what is wrong and how to fix it, go to the slide, or hand it to the agent.
- **Chat**: the floating bar runs Claude Code, Codex or OpenCode, whichever you have installed, using that tool's own login and model. Each keeps its session across messages.

- **Follow edits** (the eye): the preview goes to the slide an agent just changed, whether it came from this chat or an agent in a terminal. Turn it off to stay where you are.

Chat agents edit only through the `present` tools, so every change is validated and undoable and the preview updates live. They can read files but have no shell or file-writing tools. Claude Code and Codex can read outside the deck; OpenCode is denied. Tools in your own OpenCode setup are not otherwise restricted.

## Desktop app

`npm run desktop` runs Present as a desktop app, with the Studio window for each deck, and `npm run package` builds a Windows installer in `release/`. Each deck opens in its own window. The app brings its own runtime, so the installed version does not need Node. Rendering, screenshots and PDF export still use the Chrome or Edge on the machine, and the chat still uses the agent CLIs you have installed.

`electron-builder.yml` keeps the app unpacked, because the server compiles its own sources at run time. `scripts/desktop-after-pack.cjs` replaces each `@present` package with a stub that points back at `packages/`, because Node will not strip types under `node_modules`. The installer is not code-signed, so Windows SmartScreen warns on first run. To test a packaged build, set `PRESENT_DESKTOP_EXE` to its `Present.exe` and run `tests/desktop.test.ts`.

## Presenting

In the app, press **Present** or `F5`. The deck goes full screen on your external display, and the presenter view opens on your main display. With several displays you pick one; with a single display the deck takes it, and `P` opens the presenter view on top. If a screen is plugged in or pulled out during the talk, the windows move to match.

The presenter view shows the slide on screen at the end of the current step, the next step or slide, notes, a timer you can pause and reset, the time of day, and buttons for the controls. Clickers and keys work from either window: `→ Space` next, `←` previous, `B` black screen, `R` replay, `S` autoplay or steps, `Esc` end the show. An exported HTML file has the same presenter view: press `P` and drag the window where you want it.

The show stays live. Edits reach both windows as they are made, holding the current frame, and Studio stays open behind the presenter view with the chat, so you can fix a slide between talks or during a rehearsal. Do not leave an agent working during a real talk unless you want the room to watch.

## In the room

Autoplay by default: the intro and steps run by themselves, and one Next moves to the next slide. Press `S` for step mode.

`→ Space` next · `←` previous · `↓ D` deep dive · `↑ U` back up · `G` overview · `R` replay · `Z` or click a marked part to zoom · `F` full screen · `B` black screen · `P` presenter view · `M` toggle motion · `?` help

Address: `?steps`, `?still`, `?only=1,3,7`, `#7`.

## Layout

```
packages/core      parser, macros, figures, phrases, patterns, score compiler, ops, static checks (no DOM)
packages/runtime   timeline, tracks, player, camera, theme (ships in every deck)
packages/render    headless driver, rendered checks, exporters
packages/mcp       the tools layer: MCP server, and connecting agents to it (no UI)
packages/studio    dev server, inspector overlay, Studio app and agent runner
packages/desktop   Electron shell: windows, deck picker, capture picker, menus, shows across displays
packages/cli       commands
examples/          sample deck
tests/             npm test; UPDATE_GOLDEN=1 refreshes golden images
```

`fixtures/reference/` and the reference deck are private test material and are gitignored. `node fixtures/reference/build-example.mjs` builds the whole talk into `examples/enterprise-rl/`, which is gitignored too. Slides 3, 5 and 9 keep their animation; the rest are finished drawings.

## Security

Slides are data: scripts and event handlers are rejected, links must be http(s), and images must be local. Only `tracks/`, `scenes/` and `macros/` run code, so treat a deck that contains them as code. A page in `<Embed>` runs scripts too, but in a sandboxed frame with no access to the deck, the file system or its own origin. The dev server binds to `127.0.0.1` and requires a session token and same origin.

## Licences

Theme tokens are from Primer Primitives and icons from Octicons, both MIT. Mona Sans, Mona Sans Mono and Inter are SIL OFL; see `packages/runtime/fonts/OFL-MonaSans.txt`.
