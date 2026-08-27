import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, assignSymbols } from "../src/index.ts";

/**
 * The file is the unit of one derive call, and the model never names symbol keys — it returns the indexes it was
 * shown, and the mapping back to real symbols happens in code. So anchors cannot be invented, and a symbol the
 * model forgets is placed by its call graph instead of being left an orphan.
 */
const PORT = 7406, LLM_PORT = 7407;
let root: string, core: Core, llm: ReturnType<typeof Bun.serve>;
const seen: Record<string, { idxs: number[]; sawSource: boolean }> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lgs-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // helper is called by main, so a forgotten helper has somewhere to be swept to
  writeFileSync(join(root, "src/alpha.ts"), [
    "export function helper(x: number) { /* marker-helper */ return x + 1; }",
    "export function main(x: number) { /* marker-main */ return helper(x) * 2; }",
    "export function other(x: number) { /* marker-other */ return x - 1; }",
  ].join("\n") + "\n");
  writeFileSync(join(root, "src/beta.ts"), "export function beta(x: number) { return x; }\n");
  writeFileSync(join(root, "src/gamma.ts"), "export function gamma(x: number) { return x; }\n");

  llm = Bun.serve({
    port: LLM_PORT,
    async fetch(req) {
      const body: any = await req.json();
      const prompt: string = body.messages.at(-1).content;
      if (/Name and describe one folder/.test(prompt)) {
        const dir = /## Folder `([^`]*)`/.exec(prompt)?.[1] ?? "?";
        return Response.json({ choices: [{ message: { content: JSON.stringify({ title: `Folder ${dir}`, spec: "an area" }) }, finish_reason: "stop" }] });
      }
      const file = /Scope: the single file `([^`]+)`/.exec(prompt)?.[1] ?? "?";
      seen[file] = { idxs: [...prompt.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1])), sawSource: /marker-\w+/.test(prompt) };
      // alpha: claim main and other, forget helper, and throw in an index that was never offered
      const behaviors = file.endsWith("alpha.ts")
        ? [{ title: "Main path", spec: "doubles", symbols: [2, 99], examples: [] }, { title: "Other", spec: "decrements", symbols: [3], examples: [] }]
        : file.endsWith("gamma.ts")
          ? [] // the model gives up entirely
          : [{ title: "Beta", spec: "identity", symbols: [1], examples: [] }];
      return Response.json({ choices: [{ message: { content: JSON.stringify({ behaviors }) }, finish_reason: "stop" }] });
    },
  });
  mkdirSync(join(root, ".lenz"), { recursive: true });
  writeFileSync(join(root, ".lenz/config.yaml"),
    `max_concurrent_llm: 6\nrun_timeout: 30\nllm:\n  provider: openrouter\n  model: stub\n  base_url: http://127.0.0.1:${LLM_PORT}\n`);
  process.env.OPENROUTER_API_KEY = "test-key";
  core = new Core({ root, port: PORT, cli: [process.execPath, join(import.meta.dir, "../src/cli.ts")] });
  await core.start({ watch: false });
});
afterAll(async () => {
  for (const r of core.runs.list()) if (r.status === "running" || r.status === "queued") core.runs.kill(r.id);
  await Bun.sleep(400);
  llm.stop(true); await core.close(); rmSync(root, { recursive: true, force: true });
});

test("one call per file, indexes map to exact anchors, and nothing is left unowned", async () => {
  await core.deriveAll("all").done;

  // every file got its own call, and each call carried real source rather than signatures alone
  expect(Object.keys(seen).sort()).toEqual(["src/alpha.ts", "src/beta.ts", "src/gamma.ts"]);
  expect(seen["src/alpha.ts"].idxs).toEqual([1, 2, 3]);
  expect(seen["src/alpha.ts"].sawSource).toBe(true);

  const byTitle = (t: string) => core.store.all().find((n) => n.title === t);
  const anchorsOf = (t: string) => (byTitle(t)?.anchors ?? []).map((a) => a.name).sort();

  // the forgotten symbol landed with the behavior that calls it, not in a bucket of its own
  expect(anchorsOf("Main path")).toEqual(["helper", "main"]);
  expect(anchorsOf("Other")).toEqual(["other"]);
  // index 99 was never offered, so it simply does not exist
  expect(core.store.all().flatMap((n) => n.anchors ?? []).every((a) => a.file.startsWith("src/"))).toBe(true);

  // a file the model refused to group still becomes one honest behavior named after it
  expect(anchorsOf("gamma")).toEqual(["gamma"]);

  // the whole point: derive leaves no orphans
  expect(core.orphans().orphan_count).toBe(0);
}, 30_000);

test("reset 'none' keeps every existing derived node", async () => {
  const before = core.store.all().filter((n) => n.derived).map((n) => n.id).sort();
  expect(before.length).toBeGreaterThan(0);

  await core.deriveAll("none").done;

  const after = new Set(core.store.all().map((n) => n.id));
  for (const id of before) expect(after.has(id)).toBe(true);
}, 30_000);

test("assignSymbols is total and order-stable without any model help", () => {
  const syms = ["a", "b", "c"].map((n, i) => ({ key: `f.ts##function#${n}`, name: n, file: "f.ts", start_line: i + 1, end_line: i + 1, kind: "function", container: "", sig: "", body: "", exported: 1 })) as any[];
  const db = { refsFrom: () => [], refsTo: () => [] } as any;

  // no groups at all → the file is one behavior
  const none = assignSymbols(syms, [], db, "dir/f.ts");
  expect(none.length).toBe(1);
  expect(none[0].title).toBe("f");
  expect(none[0].syms.length).toBe(3);

  // duplicate and out-of-range claims: first claim wins, garbage is ignored, leftovers still land
  const dup = assignSymbols(syms, [{ title: "one", symbols: [1, 2] }, { title: "two", symbols: [2, 7, -1] }], db, "dir/f.ts");
  expect(dup.map((b) => b.title)).toEqual(["one", "f: remaining"]);
  expect(dup[0].syms.map((s: any) => s.name)).toEqual(["a", "b"]);
  expect(dup[1].syms.map((s: any) => s.name)).toEqual(["c"]);
});
