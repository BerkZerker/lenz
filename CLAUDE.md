# lenzgraph — notes for agents working on this repo

- Runtime is **bun** (`~/.bun/bin/bun`); tests are `bun test packages`, typecheck `bun run typecheck`.
- Workspace: `packages/structure` (tree-sitter + sqlite index), `packages/core` (daemon/CLI), `packages/gui` (React; `bun run build:gui` writes `packages/core/static`).
- `web-tree-sitter` is pinned to **0.22.6** to match the grammar ABI in `tree-sitter-wasms@0.1.13`. Do not bump one without the other.
- Symbol keys are `file#container#kind#name`. Anchors add `sig`/`body` hashes; the `anchors` sqlite table mirrors node yaml.
- All node mutations go through `Core`/`NodeStore.save` (yaml → anchors mirror → `node.updated` event). The GUI never touches disk.
- Run the daemon on a target project: `bun packages/core/src/cli.ts serve` from inside it. `examples/demo` and `examples/brownfield` are ready.
- Core's fake-agent test (`packages/core/test/core.test.ts`) exercises dispatch → hook → lock → build → verify → drift without calling Claude.
