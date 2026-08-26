# lenz

An agent dev kit for closing the human↔agent feedback loop. One multi-resolution graph of the
project (L0 intent · L1 behavior · L2 structure · L3 code); the GUI is a set of zoom lenses over it.
Spec: [`lenz-spec.md`](./lenz-spec.md).

## Requirements

- [bun](https://bun.sh) ≥ 1.2
- [Claude Code](https://claude.com/claude-code) CLI on `PATH` (`claude`) — the only agent adapter in V1
- a Gemini API key for the non-agentic calls (propose, derive, reconstruction, spec comparison).
  Put `GEMINI_API_KEY=...` in a `.env` at the project root (see `.env.example`; gitignored)
  — `.lenz/.env` also works. Model defaults to `gemini-3.7-flash`; override via `llm:` in `config.yaml`
  (`llm: { provider: claude }` routes those calls through Claude Code instead). Builds always run
  on Claude Code.
- optional: `@sourcegraph/scip-typescript` for precise references (`lenz index --scip`)

## Quick start

```bash
bun install
bun run build:gui                       # → packages/core/static
(cd packages/core && bun link)          # puts `lenz` on PATH

cd /path/to/your-ts-project
lenz init                          # writes .lenz/{config.yaml,agents/claude.yaml,nodes/}
lenz start                         # daemon + GUI at http://localhost:7331
```

To get `lenz` on your `PATH`: `cd packages/core && bun link` (symlinks it into `~/.bun/bin`,
which the bun installer already added to your shell). Alternatively run `bun packages/core/src/cli.ts`.

### Greenfield

1. Press `7` (Propose), paste a brain-dump, hit propose. Claude returns an intent/behavior tree
   (fan-out ≤ 9 enforced, retried once). Nodes land as `proposed`.
2. Walk the tree: `a` approves a subtree (→ `specified`), `e` edits (yaml), `x` deletes.
3. `2` (Queue) shows `specified` nodes in dependency order; `d` dispatches one. Up to
   `max_concurrent_runs` agents run at once, coordinating through file locks.
4. A finished build lands in `3` (Verify): examples (then vs. actual), machine check, blind
   reconstruction verdict, symbol change list with owner dropdowns, collateral drift.
   `a` approves (→ `verified`), `r` rejects with a note (→ re-dispatch with the note).

### Brownfield

Press `g` (or the **generate graph** button in the graph view). One LLM call per folder,
bottom-up; everything lands `proposed` and appears in the tree as it is derived (progress in the
status bar). Once a graph exists the button becomes **regenerate graph** and asks whether to
replace only unreviewed (`proposed`) derived nodes or all of them. Any node's inspector has a
**regenerate** button: an intent re-derives its folder subtree, a behavior rewrites its
spec + examples from its anchored code.

`4` (Orphans) is the burn-down: symbols with no owning behavior node.

### Editing specs

Spec edits stage the node (`8` Stage shows the staged set and its blast radius). `c` confirms →
topological dispatch; `i` toggles immediate mode. Manual code edits under an anchored symbol flag
`drifted` (lazy — nothing is auto-dispatched); resolve with "spec still holds" or "re-build".

## Graph lens

The Graph lens (`1`) is a local, voxel-style view: only the **cursor** (an intent or the root), its parent
(`▲ up`) and its ≤ 9 children are loaded. Click an intent to move the cursor there (old nodes unload);
click a behavior to open its frosted panel. Layouts: `tree` (fan below the cursor) or `force`; `re-sort`
re-lays; `fit` refits; wheel zooms; drag pans. Zoom never changes on a click. Node fill = **area** (one
color per top-level subtree, used across the tree pane and links); ring = status. Dashed edges between
siblings are `deps` (orange) and code-level calls (area color). The minimap (bottom-left) shows your path
root → cursor with the siblings at each level. URLs deep-link: `#graph/<node id>`.

Each node carries a Gemini-written **summary** ("does X, hands off to [[A]], relies on [[B]]") derived
from the symbol graph; `[[links]]` render color-coded and navigate. Summaries are written after
derive/propose/build, or on demand (`summarize` button, `lenz summarize [--force]`).

### Flow mode and the flow lens

- **`flow`** toggle in the graph toolbar: relation edges become directed, animated call arrows between the loaded nodes, labeled with the symbol pair that connects them. Hover or select a node to trace: downstream hops are orange (`+1`, `+2`…), upstream callers blue (`−n`); everything else fades. The trace follows you as you move levels, since relations are lifted to whatever level is loaded.
- The node panel lists **calls →** / **← called by** with `via` symbols; **`flow →`** opens the **6 flow** lens at the node's most-connected symbol.
- **6 flow** lens: entry points (exported symbols and top-level functions in files matching `entry_globs`, plus pinned keys) and a collapsible static call tree (⊞/⊟; auto-open to depth 2), each symbol tagged with its owning node (click the tag to jump to it in the graph). Deep link: `#flow?from=<file#container#kind#name>`.

### Explorer (left pane)

VS Code style: chevrons collapse/expand, ⊞/⊟ expand/collapse all, `nodes` | `files` toggle. The files view shows folders → files → symbols with owner colors (dashed = orphan); clicking an owned symbol jumps to its node.

## Keys

`j/k` move · `enter` drill · `esc/h` up · `/` search · `1–6` lenses (graph, queue, verify, orphans,
runs, flow) · `7/8` propose/stage · `a` approve · `r` reject · `e` edit · `d` dispatch · `n` new ·
`x` delete · `c` confirm staging · `i` immediate · `?` help

## CLI

```
lenz init | start [--port N] | index [--scip] | propose <file> [--parent id]
          | dispatch <node> | verify <node> | lock acquire|release <file> --run <id>
          | node set <id> <path> <value> | status
```

`node set` is what build agents use to write example `run` commands back
(`lenz node set n_x examples.ex_1.run "bun test tests/x.test.ts -t ex_1"`).

## Layout

```
packages/structure   tree-sitter extraction (queries/*.scm), sqlite schema, syntactic refs,
                     anchor resolution, watcher, flow, SCIP reader
packages/core        nodes (yaml store + anchors mirror), locks, run manager, verification,
                     staging/blast radius, drift, propose/derive, daemon, CLI
packages/gui         React + Vite + zustand, built into packages/core/static
examples/demo        greenfield demo (todo store)      examples/brownfield   derive demo
```

Per-project state lives in `.lenz/`: `config.yaml`, `CONVENTIONS.md` (prepended to every
prompt), `agents/claude.yaml` (adapter), `nodes/**/*.yaml` (committed), `runs/` and
`structure.db` (gitignored).

## How locks work

Every agent run gets a generated Claude Code settings file whose `PreToolUse` hooks call
`lenz hook pre` for `Write|Edit|MultiEdit|NotebookEdit|Bash`. The hook asks the daemon for the
file lock; if another run holds it and wrote within `lock_cooldown` (45s) the tool call is denied
with a reason the agent can act on. Otherwise the lock transfers and the previous holder is told on
its next tool call. Bash commands are scanned for write targets (redirections, `sed -i`, `tee`,
python `open(...,'w')`, …) since agents often edit through the shell.

## Tests

```bash
bun test                 # structure + core (core includes a fake-agent end-to-end run)
bun run typecheck
```
