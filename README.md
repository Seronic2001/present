# Present

Animated slides that AI agents can build, see and fix. A deck is a folder of plain text. It exports to one self-contained HTML file.

The core rule: a frame is a pure function, `render(document, slide, step, t) → pixels`. Any moment of any animation can be reproduced, so an agent can look at it and a test can check it.

## Quick start

Needs Node 24 (it runs the TypeScript directly) and Chrome or Edge.

```sh
npm install
node packages/cli/src/bin.ts dev examples/launch-story     # open the URL, press I for Studio
```

Start your own deck, then point an agent at it:

```sh
node packages/cli/src/bin.ts init my-talk   # writes .mcp.json, AGENTS.md and a Claude Code skill
cd my-talk && claude                        # the agent has the present MCP tools
```

## Commands

```
present init [dir]                          new deck
present dev [dir] [--port 4173]             live preview with Studio
present check [dir] [--static]              diagnostics
present outline [dir]                       structure, timing, revision
present render <dir> <slide> [--step n] [--t ms] [--out f.png]
present filmstrip <dir> <slide> <step>      contact sheet of one step over time
present export <dir> html|pdf|png <out> [--steps]
present mcp [dir]                           MCP server on stdio
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

Three levels of power: layout macros (`Header`, `Columns`, `Card`, `Stat`), `<Diagram>` for dense drawings with raw SVG allowed, and code in `tracks/*.ts` and `macros/*.ts` for what the Score cannot express. `present mcp`'s `catalog` tool lists everything with examples.

A custom track default-exports `(el, args, api) => apply(p)`. `apply` must depend only on `p`, and `p=0` and `p=1` must leave the drawing as it was when used in a loop.

## In the room

Autoplay by default: the intro and steps run by themselves, and one Next moves to the next slide. Press `S` for step mode.

`→ Space` next · `←` previous · `G` overview · `R` replay · `Z` or click a marked part to zoom · `F` full screen · `P` presenter view · `M` toggle motion · `?` help

Address: `?steps`, `?still`, `?only=1,3,7`, `#7`.

## Layout

```
packages/core      parser, macros, score compiler, ops, static checks (no DOM)
packages/runtime   timeline, tracks, player, camera, theme (ships in every deck)
packages/render    headless driver, rendered checks, exporters
packages/studio    dev server and inspector overlay
packages/cli       commands and the MCP server
examples/          sample deck
tests/             npm test; UPDATE_GOLDEN=1 refreshes golden images
```

`fixtures/reference/` and the reference deck are private test material and are gitignored.

## Security

Slides are data: scripts and event handlers are rejected, links must be http(s), and images must be local. Only `tracks/` and `macros/` run code, so treat a deck that contains them as code. The dev server binds to `127.0.0.1` and requires a session token and same origin.

## Licences

Theme tokens are from Primer Primitives and icons from Octicons, both MIT. Mona Sans, Mona Sans Mono and Inter are SIL OFL; see `packages/runtime/fonts/OFL-MonaSans.txt`.
