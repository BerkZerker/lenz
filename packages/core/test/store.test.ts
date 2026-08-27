import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../src/index.ts";

let root: string, core: Core;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lgf-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/a.ts"), "export function a() { return 1; }\n");
  core = new Core({ root, port: 7404, cli: [process.execPath, join(import.meta.dir, "../src/cli.ts")] });
  await core.start({ watch: false });
});
afterAll(async () => { await core.close(); rmSync(root, { recursive: true, force: true }); });

test("deleting a node non-recursively floats its children up", () => {
  // a bulk reset tears down intents and re-homes whatever survives
  const parent = core.store.create({ kind: "intent", title: "area" });
  const kids = Array.from({ length: 9 }, (_, i) => core.store.create({ kind: "behavior", title: `kid ${i}`, parent: parent.id }));
  const siblings = Array.from({ length: 5 }, (_, i) => core.store.create({ kind: "intent", title: `other ${i}` }));

  expect(() => core.store.delete(parent.id, false)).not.toThrow();

  // every child survived and is now at the root
  for (const k of kids) expect(core.store.get(k.id)?.parent).toBeNull();
  expect(core.store.children(null).length).toBe(kids.length + siblings.length);
  expect(core.store.get(parent.id)).toBeNull();
});

test("reloading rebuilds the anchor mirror instead of accumulating stale rows", () => {
  for (const n of core.store.all()) core.store.delete(n.id); // previous test leaves survivors at the root
  const n = core.store.create({ kind: "behavior", title: "owner", anchors: [{ file: "src/a.ts", container: "", kind: "function", name: "a" }] as any });
  // simulate a node that vanished while the daemon was down: rows in the mirror, no yaml behind them
  core.idx.db.setAnchors("n_ghost", ["src/a.ts##function#a", "src/gone.ts##function#dead"]);
  expect(core.idx.db.ownersOf("src/a.ts##function#a")).toContain("n_ghost");

  core.store.load();

  expect(core.idx.db.ownersOf("src/a.ts##function#a")).toEqual([n.id]);
  expect(core.idx.db.ownersOf("src/gone.ts##function#dead")).toEqual([]);
  // and the symbol is only owned by a node that really exists, so orphan detection is honest again
  for (const { node_id } of core.idx.db.ownedSymbols()) expect(core.store.get(node_id)).not.toBeNull();
});
