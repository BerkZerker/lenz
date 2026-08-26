# lenzgraph — spec v1.0 (buildable)

> An agent dev kit for closing the human↔agent feedback loop. The core is a
> multi-resolution graph of the project that both human and agent work through;
> the GUI is a set of zoom lenses over it.

## Problem

Agents write code well. The bottleneck is information flow between human and
agent — three loops:

1. **Context** — what does the codebase actually look like?
2. **Intent** — spec → agent, without over- or under-building.
3. **Verify** — judge output without reading raw code. This is the crown jewel:
   agents produce code faster than humans can review it, and approval without
   understanding is theater.

## MVP definition

The MVP is a local tool that, on a TypeScript project:

- derives L2/L3 structure from code, keeps it in sync, and tracks ownership;
- lets a human turn a brain-dump into an approved node tree (greenfield) or
  derive one from existing code (brownfield);
- dispatches Claude Code per node, with up to N agents concurrently
  coordinating through file locks;
- presents each completed node for verification via examples, blind
  reconstruction, and a symbol-level change list — never raw diffs;
- flags drift when anchored code changes without its spec changing.

Explicit MVP cuts (see *Later*): only Claude Code as agent; SCIP references for
TypeScript only (syntactic fallback elsewhere); machine tier = agent-written
checks, no fuzzing/property tests; no sandboxing beyond cwd + timeout; no TUI.

## Core model

### Zoom levels

One graph, four resolutions of the same territory:

- **L0 — Intent**: "users can reset their password"
- **L1 — Behavior**: contracts + examples — "POST /reset emails a token,
  expires in 1h, expired token shows error X"
- **L2 — Structure**: files, folders, symbols, edges
- **L3 — Code**: the files

L0/L1 are **authored** (proposed by agent, approved by human) and stored in
`.lenzgraph/nodes/`. L2/L3 are **derived** by `packages/structure` and stored
in `.lenzgraph/structure.db` (gitignored, rebuildable).

### Nodes

Two kinds. **Intent** nodes group; **behavior** nodes are leaves that own code.

```yaml
# .lenzgraph/nodes/auth/password-reset.yaml   (path = slug, id is stable)
id: n_7f3a2c
kind: behavior            # intent | behavior
title: Reset password via emailed token
parent: n_1a9b00          # intent node; null = root
deps: [n_44c1d2]          # must be built first (topological build order)
status: specified         # see lifecycle
spec: |
  POST /auth/reset with an email sends a single-use token valid for 1h.
  Consuming the token with a new password updates the hash and invalidates
  the token. Expired or unknown tokens return 410.
examples:
  - id: ex_a1
    name: happy path
    given: user bob@x.com exists
    when: POST /auth/reset {email: bob@x.com}; consume token with pw "hunter2"
    then: 200; bob can log in with hunter2
    run: bun test tests/auth/reset.test.ts -t "ex_a1"     # written by agent
    expect: { mode: exit0 }                                 # see Examples
  - id: ex_a2
    name: expired token
    given: token issued 61 minutes ago
    when: consume token
    then: 410 Gone
    run: bun test tests/auth/reset.test.ts -t "ex_a2"
    expect: { mode: exit0 }
anchors:                  # written by core after a run; edited in Verify
  - { kind: function, name: requestReset, container: "", file: src/auth/reset.ts,
      sig: "9c1e…", body: "4fa0…" }
  - { kind: function, name: consumeReset, container: "", file: src/auth/reset.ts,
      sig: "e77b…", body: "0b13…" }
machine:                  # optional, agent-written
  run: bun test tests/auth/
verification:             # written by core
  examples: { pass: 2, fail: 0, at: 2026-08-25T14:02:11Z }
  machine:  { ok: true, at: … }
  reconstruction: { verdict: match, at: … }
  approved_by: human
  approved_at: …
```

Rules:

- Only behavior nodes have `anchors`, `examples`, `machine`. An intent node's
  symbols are the union of its descendants'.
- **Fan-out cap 9**, enforced: proposals with >9 children are rejected and
  re-prompted; the editor refuses a 10th child until you add a grouping node.
- `id` never changes. File path = slug path under the parent; renames are git
  renames.

### Lifecycle

```
proposed → specified → building → built → verified
                                    ↘ rejected → building
any state (except building) → drifted   when an anchor changes and spec didn't
```

- `proposed`: agent-suggested, not yet approved. Approving → `specified`.
- `drifted` remembers its previous status; resolving drift ("spec still
  holds" or "re-build") returns it there or to `building`.

### Anchors

An anchor is a symbol key `{kind, name, container, file, sig, body}` where
`sig` = hash of normalized signature, `body` = hash of normalized body text.
Re-resolved against `structure.db` on every sync:

| miss on | match found by | action |
|---|---|---|
| file | same `body` elsewhere | re-anchor (moved), no drift |
| name | same file + `sig` | re-anchor (renamed), no drift |
| body only | same file + name | **drift** — code changed |
| everything | — | **drift** — deleted |

Drift is suppressed for the node currently `building` (its code is *supposed*
to change) and applied to it as anchor refresh when the run ends.

### Ownership and orphans

Every symbol *should* be owned by exactly one behavior node. Symbols with no
owner are **orphans**, shown in the Orphans lens:

- Greenfield: an orphan means the agent built something nobody asked for.
- Brownfield: everything starts orphaned; orphan count is the derivation
  progress metric.

Excluded from orphan counting via config globs (tests, generated, config).

### Hierarchy and edges (L2/L3)

- **Hierarchy = containment**, 1:1 with the filesystem: `symbol → file →
  folder`. The graph never contradicts disk.
- **Edges exist only between symbols** (`calls`, `imports`, `extends`,
  `implements`). File/folder edges are aggregated on read, never stored.
- **Flow view** (human lens): static call graph from entry points, children
  ordered by source position. Precision is per-edge (`scip` vs `syntactic`),
  rendered differently.

## `packages/structure`

Our own parser, purpose-built. (CodeGraph 1.5.0 evaluated and rejected: 87k
lines, hand-walked AST extraction, ~11k lines of fuzzy name heuristics; we'd
use ~3% and the 3% is the easy part.)

- **Extraction**: `web-tree-sitter` + WASM grammars from `tree-sitter-wasms`.
  One `.scm` query file per language with `@definition.{function,method,
  class,interface,type,const}` and `@reference.{call,import,extends,
  implements}` captures. Engine is generic; a language = a query file +
  extension map entry. MVP query files: `typescript`, `tsx`; `python` and `go`
  files ship but are best-effort.
- **Symbol key** as in Anchors. `container` is the enclosing class/namespace
  path (`""` at file top level). Normalization strips whitespace/comments
  before hashing.
- **References**: if `index.scip` exists in the project root (produced by
  `scip-typescript`), read it (protobuf) for precise edges, `provenance:
  scip`. Otherwise resolve query-captured references through the import graph
  by name, `provenance: syntactic`. No confidence scores — an edge resolves or
  it lands in `unresolved_refs`. `lenzgraph index --scip` runs the indexer if
  installed.
- **Entry points**: exported symbols from files matching `entry_globs` in
  config, plus anything human-pinned in the Flow lens.
- **Watcher**: chokidar on source globs, debounced 300ms, content-hash keyed.
  Re-extracts changed files only, then re-resolves refs touching them, then
  emits `symbols_changed {added, removed, changed}` with symbol keys.

Schema (`bun:sqlite`):

```sql
files        (path PK, hash, language, indexed_at)
symbols      (key PK, kind, name, container, file, sig, body,
              start_line, end_line, exported INT)
refs         (src_key, dst_key, kind, provenance, line)
unresolved   (src_key, name, kind, line)
entry_points (key PK, source: 'auto'|'pinned')
anchors      (node_id, key, PRIMARY KEY(node_id, key))   -- mirror of yaml
```

`anchors` is written from node yaml on load and on every node save, so orphan
(`symbols LEFT JOIN anchors WHERE node_id IS NULL`), drift, and blast radius
are single joins.

## `packages/core`

Headless daemon (`lenzgraph serve`, Bun) owning all state and orchestration.
Serves the GUI and exposes:

- `GET/PUT /nodes`, `/nodes/:id`, `/tree`, `/orphans`, `/flow?from=`,
  `/runs`, `/locks`, `/staging`
- `POST /propose` (greenfield), `/derive` (brownfield), `/staging/confirm`,
  `/runs/:id/approve|reject`, `/nodes/:id/verify` (execute examples),
  `/nodes/:id/reconstruct`, `/locks/acquire|release`
- `WS /events`: `node.updated`, `run.event`, `lock.changed`, `drift.detected`,
  `structure.synced`

All node mutations go through core → yaml write → `anchors` mirror → event.
The GUI never touches disk.

### Staging and blast radius

- Spec edits set `staged: true` on the node (in yaml, so it survives restarts).
- Blast radius of the staged set = staged nodes ∪ nodes whose `deps` include a
  staged node ∪ nodes anchored to any symbol referenced by a staged node's
  anchors (one hop over `refs`). Shown live in the Stage lens.
- **Confirm** dispatches the staged set in topological order (by `deps`),
  marks blast-radius nodes `needs-reverify` (a flag, not a status), clears
  `staged`. Immediate mode = confirm on every edit, toggle in the status bar.
- Drift from manual code edits is **lazy**: flag only, no auto-dispatch.

### Agent dispatch

Agents are headless CLI processes. Adapter is declarative
(`.lenzgraph/agents/claude.yaml`):

```yaml
command: claude -p {prompt_file} --output-format stream-json --verbose
         --permission-mode bypassPermissions --settings {settings_file}
resume:  claude -p {prompt_file} --resume {session_id} …
events:  claude-stream-json          # parser id in core
hooks:   claude-settings             # generator id: writes PreToolUse/PostToolUse
                                     # hooks that call `lenzgraph lock …`
```

Flags verified against current Claude Code docs at build time.

**Prompt assembly** (ours, logged to `.lenzgraph/runs/<run_id>/prompt.md`):
project conventions (`.lenzgraph/CONVENTIONS.md` if present) · target node
spec + examples · parent intent title · sibling/dep node titles + one-line
specs · source of currently anchored symbols · file-lock instructions · output
contract: "make each example's `run` command pass; write `run` and `machine`
commands back into the node yaml via `lenzgraph node set`".

**Run record** (`.lenzgraph/runs/<run_id>/`): `prompt.md`, `events.jsonl`,
`result.json` — `{changed_symbols, locks_held, exit, duration}`.
`changed_symbols` comes from the watcher during the run window, not from the
agent: every symbol added/changed while this run held the file is proposed as
an anchor of the node. Human confirms in Verify.

Run limits: `max_concurrent_runs` (default 2), `run_timeout` (default 20m). No
mid-run steering — kill and re-dispatch with the rejection note appended.

### File locks

Agents edit the real tree concurrently; core is the lock broker.

- Every write tool call in an agent goes through a **PreToolUse hook** that
  runs `lenzgraph lock acquire <file> --run <id>`. Core grants immediately if
  free or held by the same run.
- If held by another run: the holder's **consent is inferred from activity**.
  Grant if the holder hasn't written the file within `lock_cooldown` (default
  45s); otherwise **deny** — the hook blocks the tool call with the reason
  ("held by run r_12, active; retry later or work elsewhere") and the
  requester's agent sees it and adapts.
- On grant-with-transfer, the previous holder is told on its next tool call
  (hook stdout injection): "run r_9 edited `src/x.ts` lines 40–72 while you
  held it; review before continuing." That's the *review* step of the
  protocol, mechanized.
- Locks release on run end, or explicitly via `lenzgraph lock release`.
  Core times out holders whose run has died.
- Every grant/deny/transfer is logged and streamed to the Runs lens.

This is the MVP mechanization of holder-affirms/denies/reviews; true
agent↔agent messaging is *Later*, gated on agent CLIs exposing a mid-run
channel.

## Flows

### Greenfield

1. Human brain-dumps into the Propose lens (text; voice via OS dictation).
2. Core dispatches a **propose** run (spec withheld → none exists) whose
   output contract is a JSON tree of intent/behavior nodes with titles, specs,
   examples (given/when/then only — no `run` yet). Fan-out validated; retried
   once on violation.
3. Nodes land as `proposed`. Human walks them: approve / edit / delete /
   regroup. Approving a subtree → `specified`.
4. Confirm → topological dispatch. Examples' `run` commands are written by the
   build agent.

### Brownfield

1. `lenzgraph derive` walks the containment tree **bottom-up**: one LLM call
   per folder, given its files' symbols (names, signatures, docstrings, first
   lines) and its subfolders' already-derived intent titles. Output: proposed
   behavior nodes over this folder's symbols (with anchor keys — core validates
   every key exists, drops hallucinations) and one intent node for the folder.
2. Everything lands `proposed`, examples marked `derived: true` (weaker
   evidence — they came from code, not intent). Human ratifies in the same
   approval UI. Orphans lens shows burn-down.

### Build → Verify

1. Run completes → node `built`, `changed_symbols` proposed as anchors,
   examples executed, reconstruction dispatched, machine command run.
2. Verify lens presents the node. Human approves (→ `verified`) or rejects
   with a note (→ `building`, re-dispatch with note).

## Verification

Three mechanisms, one card status:

1. **Examples** (human tier). Given/when/then approved at spec time. At verify
   time core runs each `run` (cwd = project root, `example_timeout` default
   60s) and judges by `expect.mode`:
   `exit0` · `stdout_equals` · `stdout_contains` · `json_subset` · `manual`
   (human marks pass/fail — for screenshots, UI). Lens shows **then** (intended)
   beside captured **actual**; human reads behavior, never test code.
2. **Machine** tier. `machine.run` executed; pass/fail + tail of output. The
   "confidence score" is simply the count of passing agent-written checks.
3. **Blind reconstruction**. A fresh run receives *only* the source of the
   node's anchored symbols (plus one-line signatures of what they call) and
   returns "what this does, including edge cases." A second run compares
   reconstruction to spec → `{verdict: match|mismatch, reasons[]}`. Mismatch is
   shown side-by-side; human decides "code wrong" vs "code illegible" — both
   reject. The reconstruction text is stored on the node as living docs.

## GUI

`packages/gui`: React + Vite + zustand, served by the daemon at
`localhost:7331`. Thin: every action is an API call, every update is a WS
event.

### Theme — terminal-native

- Background `#000000` (OLED black); panels `#0a0a0a`; borders `1px solid
  #262626`; **no border radius anywhere**; no shadows; no gradients.
- Font: `JetBrains Mono, ui-monospace, monospace` everywhere, 13px, line
  height 1.45. Text `#d4d4d4`; dim `#737373`.
- Accent (focus ring, active tab, primary action): `#d97757` (Claude Code
  orange). Status: specified `#737373` · building `#3b82f6` · built `#eab308`
  · verified `#22c55e` · rejected/drifted `#ef4444` · proposed dashed border.
- Panes divided by single box-drawing lines; headers in `UPPERCASE` dim text
  with a `▸` marker; cards are bordered boxes, not tiles.
- Fully keyboard-driven: `j/k` move, `enter` drill, `esc`/`h` up, `/` search,
  `1–6` switch lens, `a` approve, `r` reject, `e` edit, `d` dispatch,
  `?` help overlay. Mouse works but is never required.

### Layout

```
┌──────────────┬──────────────────────────────┬──────────────────────┐
│ TREE         │ FOCUS                        │ INSPECTOR            │
│ app          │ ┌─ card ─┐ ┌─ card ─┐        │ spec · examples ·    │
│ ▸ auth  ●    │ │ …      │ │ …      │        │ anchors · verify ·   │
│   reset ●    │ └────────┘ └────────┘        │ reconstruction       │
│   login ○    │                              │                      │
│ ▸ billing    │ breadcrumb: app ▸ auth       │                      │
├──────────────┴──────────────────────────────┴──────────────────────┤
│ 2 runs · 3 locks · 1 drifted · staged: 4 (blast 9)  [immediate: off]│
└─────────────────────────────────────────────────────────────────────┘
```

Tree pane = the minimap: dimmed beyond the ego-neighborhood, you-are-here
marker. Never renders edges.

### Lenses (each answers one question)

| # | Lens | Question | Focus pane shows |
|---|---|---|---|
| 1 | Graph | what is this? | focused node's children as cards; up = parent |
| 2 | Queue | what's next? | topo-ordered `specified` nodes; dispatch button |
| 3 | Verify | what needs my judgment? | `built` + `drifted` nodes; approve/reject |
| 4 | Orphans | what code has no owner? | orphan symbols grouped by file; assign to node |
| 5 | Runs | what are agents doing? | live event streams, locks table, kill |
| 6 | Flow | how does this execute? | call tree from an entry point, provenance-styled |

Plus **Propose** (greenfield input + proposal review) and **Stage** (staged
set + blast radius + confirm), reached from the status bar. There is no "view
the whole graph" anywhere.

Verify card detail tabs: **Examples** (then vs actual per example) ·
**Reconstruction** (spec | reconstruction, verdict, reasons) · **Machine** ·
**Changes** (symbols added/changed/removed grouped by file, each with an
owner dropdown: this node / other node / leave orphan) · **Collateral** (other
nodes drifted during this run).

## Repository layout

```
lenzgraph/
  package.json            bun workspace
  packages/
    structure/            tree-sitter engine, queries/*.scm, scip reader,
                          sqlite schema, watcher
    core/                 domain (nodes, anchors, staging, locks, dispatch,
                          verification), daemon, `lenzgraph` CLI
    gui/                  React app, built into core's static dir
  .lenzgraph/             (in a target project)
    config.yaml           languages, source_globs, ignore_globs, entry_globs,
                          orphan_exclude, test_command, max_concurrent_runs,
                          lock_cooldown, run_timeout, example_timeout
    CONVENTIONS.md        optional, prepended to every prompt
    agents/claude.yaml
    nodes/**/*.yaml       L0/L1 — committed
    runs/                 gitignored
    structure.db          gitignored
```

CLI: `lenzgraph init | serve | index [--scip] | derive | propose <file> |
dispatch <node> | verify <node> | lock acquire|release | node set <id> <path>
<value>`.

## Build order

0. `packages/structure`: query engine + TS query file, schema, watcher, anchor
   resolution, syntactic refs. SCIP reader last.
1. `packages/core` nodes + yaml store + anchors mirror + daemon + events.
2. GUI shell: theme, layout, Tree/Graph/Orphans lenses (read-only over 0–1).
3. Dispatch: adapter, prompt assembly, run records, hooks, locks. Runs lens.
4. Verify: examples runner, reconstruction, Changes tab, approve/reject.
   Verify lens. **First end-to-end slice.**
5. Greenfield: propose run + Propose lens + staging/blast + Queue lens.
6. Drift detection + Flow lens.
7. Brownfield derive.
8. Python/Go query files; SCIP.

## Later

- TUI (Ink) over the same core.
- Codex / other agent adapters.
- Agent↔agent messaging for lock negotiation.
- Property-based / fuzz machine tier; sandboxed example execution.
- Cross-cutting groups; architecture critique from edge/folder tension.
- LSP-backed live references.
- Multi-user.

## Non-goals

New language/runtime — always an overlay on normal code. Whole-graph
visualization. Formal verification.
