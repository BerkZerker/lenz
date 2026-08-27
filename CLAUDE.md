# lenz — notes for agents working on this repo

- Runtime is **bun** (`~/.bun/bin/bun`); tests are `bun test packages`, typecheck `bun run typecheck`.
- Workspace: `packages/structure` (tree-sitter + sqlite index), `packages/core` (daemon/CLI), `packages/gui` (React; `bun run build:gui` writes `packages/core/static`).
- The GUI is two panes: `components/Tree.tsx` (nodes ⇄ files, `t` toggles) and `components/Detail.tsx` (a node's description, or a file's source with an ownership gutter). Shelved lens views live in `packages/gui/src/vault/` — unreferenced so vite drops them, but still typechecked; see its README.
- `bun run typecheck` covers all three packages including the GUI and the vault.
- Indexing honours `.gitignore` and `.lenzignore` (gitignore syntax, project root, later file wins) on top of `ignore_globs`. `packages/structure/src/ignore.ts` implements the matcher; `indexAll()` re-reads them, so `POST /api/index` picks up an edit without a restart.
- `web-tree-sitter` is pinned to **0.22.6** to match the grammar ABI in `tree-sitter-wasms@0.1.13`. Do not bump one without the other.
- Symbol keys are `file#container#kind#name`. Anchors add `sig`/`body` hashes; the `anchors` sqlite table mirrors node yaml.
- All node mutations go through `Core`/`NodeStore.save` (yaml → anchors mirror → `node.updated` event). The GUI never touches disk.
- Run the daemon on a target project: `bun packages/core/src/cli.ts start` from inside it. `examples/demo` and `examples/brownfield` are ready.
- Core's fake-agent test (`packages/core/test/core.test.ts`) exercises dispatch → hook → lock → build → verify → drift without calling Claude.
- The short structured calls (derive, summarize, reconstruct, compare, propose) are `light: true` runs and go through `llm.provider` in `.lenz/config.yaml`: `gemini`, `openrouter` (any OpenAI-compatible `base_url`), or `claude` (the agent adapter). Builds always use the Claude Code adapter. `max_concurrent_llm` caps light runs; `max_concurrent_runs` caps builds.
- `Core.derive` is **one LLM call per file**. The model groups a file's still-unowned symbols into behaviors by the **index** it was shown, never by symbol key; `assignSymbols` maps indexes back to real symbols, so an anchor can't be invented and a symbol the model forgets is swept to the bucket holding most of its callers/callees. Derive therefore leaves zero orphans. There is no folder splitting.
- The intent tree **is** the folder tree, created synchronously before any call runs. Each folder intent then gets its title/spec from a second, source-free call over whatever landed under it (`folderPrompt`). Files have no dependencies; only folder intents wait, and only on their own subtree (`runDag`). `derive-file.test.ts` covers the mapping and the sweep; `derive-parallel.test.ts` covers scheduling against a stub OpenAI-compatible server.
- **There is no fan-out cap.** A node may have any number of children — losing code to a layout constraint was worse than a wide tree.
- `Core.nodeFlow` is the logic-flow view: the `calls`/`extends` ref graph collapsed onto node ownership, with every other node lifted to the queried node's depth, repeats collapsed, and cycles marked. Entirely static — no LLM. `entryNodes()` resolves detected entry points to their owning node. Both surface in the GUI's `flow` tab.
