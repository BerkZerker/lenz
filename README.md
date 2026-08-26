# lenzgraph

An agent dev kit for closing the human↔agent feedback loop. One multi-resolution graph of the
project (L0 intent · L1 behavior · L2 structure · L3 code); the GUI is a set of zoom lenses over it.
Spec: [`lenzgraph-spec.md`](./lenzgraph-spec.md).

## Requirements

- [bun](https://bun.sh) ≥ 1.2
- [Claude Code](https://claude.com/claude-code) CLI on `PATH` (`claude`) — the only agent adapter in V1
- a Gemini API key for the non-agentic calls (propose, derive, reconstruction, spec comparison).
  Put `GEMINI_API_KEY=...` in `~/.config/lenzgraph/env` (all projects) or `.lenzgraph/.env` (one
  project; gitignored). Model defaults to `gemini-3.7-flash`; override via `llm:` in `config.yaml`
  (`llm: { provider: claude }` routes those calls through Claude Code instead). Builds always run
  on Claude Code.
- optional: `@sourcegraph/scip-typescript` for precise references (`lenzgraph index --scip`)

## Quick start

```bash
bun install
bun run build:gui                       # → packages/core/static
(cd packages/core && bun link)          # puts `lenzgraph` on PATH

cd /path/to/your-ts-project
lenzgraph init                          # writes .lenzgraph/{config.yaml,agents/claude.yaml,nodes/}
lenzgraph serve                         # daemon + GUI at http://localhost:7331
```

To get `lenzgraph` on your `PATH`: `cd packages/core && bun link` (symlinks it into `~/.bun/bin`,
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

```bash
lenzgraph serve &
lenzgraph derive        # one LLM call per folder, bottom-up; everything lands `proposed`
```

`4` (Orphans) is the burn-down: symbols with no owning behavior node.

### Editing specs

Spec edits stage the node (`8` Stage shows the staged set and its blast radius). `c` confirms →
topological dispatch; `i` toggles immediate mode. Manual code edits under an anchored symbol flag
`drifted` (lazy — nothing is auto-dispatched); resolve with "spec still holds" or "re-build".

## Keys

`j/k` move · `enter` drill · `esc/h` up · `/` search · `1–6` lenses (graph, queue, verify, orphans,
runs, flow) · `7/8` propose/stage · `a` approve · `r` reject · `e` edit · `d` dispatch · `n` new ·
`x` delete · `c` confirm staging · `i` immediate · `?` help

## CLI

```
lenzgraph init | serve [--port N] | index [--scip] | derive | propose <file> [--parent id]
          | dispatch <node> | verify <node> | lock acquire|release <file> --run <id>
          | node set <id> <path> <value> | status
```

`node set` is what build agents use to write example `run` commands back
(`lenzgraph node set n_x examples.ex_1.run "bun test tests/x.test.ts -t ex_1"`).

## Layout

```
packages/structure   tree-sitter extraction (queries/*.scm), sqlite schema, syntactic refs,
                     anchor resolution, watcher, flow, SCIP reader
packages/core        nodes (yaml store + anchors mirror), locks, run manager, verification,
                     staging/blast radius, drift, propose/derive, daemon, CLI
packages/gui         React + Vite + zustand, built into packages/core/static
examples/demo        greenfield demo (todo store)      examples/brownfield   derive demo
```

Per-project state lives in `.lenzgraph/`: `config.yaml`, `CONVENTIONS.md` (prepended to every
prompt), `agents/claude.yaml` (adapter), `nodes/**/*.yaml` (committed), `runs/` and
`structure.db` (gitignored).

## How locks work

Every agent run gets a generated Claude Code settings file whose `PreToolUse` hooks call
`lenzgraph hook pre` for `Write|Edit|MultiEdit|NotebookEdit|Bash`. The hook asks the daemon for the
file lock; if another run holds it and wrote within `lock_cooldown` (45s) the tool call is denied
with a reason the agent can act on. Otherwise the lock transfers and the previous holder is told on
its next tool call. Bash commands are scanned for write targets (redirections, `sed -i`, `tee`,
python `open(...,'w')`, …) since agents often edit through the shell.

## Tests

```bash
bun test                 # structure + core (core includes a fake-agent end-to-end run)
bun run typecheck
```
