import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../src/index.ts";

/**
 * Derive against a stub OpenAI-compatible server: proves the openrouter provider is wired end to end, that
 * independent files overlap instead of running one at a time, and that a folder's intent call happens only once
 * everything underneath it — its own files and its subfolders — has been described.
 */
const PORT = 7402, LLM_PORT = 7403;
let root: string, core: Core, llm: ReturnType<typeof Bun.serve>;
let inFlight = 0, peak = 0, fileCalls = 0, folderCalls = 0;
const startedAt: Record<string, number> = {}, endedAt: Record<string, number> = {};
let seq = 0;

const FOLDERS = ["", "src", "src/a", "src/a/deep", "src/b", "src/c", "lib", "lib/x", "lib/y"];
const fileIn = (f: string) => (f ? `${f}/mod.ts` : "mod.ts");

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lgp-"));
  for (const f of FOLDERS) {
    const dir = f ? join(root, f) : root;
    mkdirSync(dir, { recursive: true });
    const tag = (f || "root").replace(/[^a-z]/gi, "");
    writeFileSync(join(dir, "mod.ts"), `export function run${tag}(x: number) { return x + 1; }\nexport class Svc${tag} { go() { return run${tag}(1); } }\n`);
  }
  // stub LLM: slow enough that serial execution would be obvious, and it reports what it was asked about
  llm = Bun.serve({
    port: LLM_PORT,
    async fetch(req) {
      const body: any = await req.json();
      const prompt: string = body.messages.at(-1).content;
      peak = Math.max(peak, ++inFlight);
      const folder = /Name and describe one folder/.test(prompt);
      const unit = folder
        ? "d:" + (/## Folder `([^`]*)`/.exec(prompt)?.[1] ?? "?").replace(/^\.$/, "")
        : "f:" + (/Scope: the single file `([^`]+)`/.exec(prompt)?.[1] ?? "?");
      startedAt[unit] = seq++;
      folder ? folderCalls++ : fileCalls++;
      await Bun.sleep(120);
      inFlight--; endedAt[unit] = seq++;

      let content: string;
      if (folder) {
        const kids = /## What is already described inside it\n\n([\s\S]*?)\n\nDo not use tools/.exec(prompt)?.[1] ?? "";
        content = JSON.stringify({ title: `Folder ${unit.slice(2) || "root"}`, spec: `kids:[${kids.replace(/\n/g, "|")}]` });
      } else {
        const idxs = [...prompt.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]));
        content = JSON.stringify({ behaviors: [{ title: `Behavior ${unit.slice(2)}`, spec: "does things", symbols: idxs, examples: [] }] });
      }
      return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    },
  });
  mkdirSync(join(root, ".lenz"), { recursive: true });
  writeFileSync(join(root, ".lenz/config.yaml"),
    `max_concurrent_llm: 6\nrun_timeout: 30\nllm:\n  provider: openrouter\n  model: stub-model\n  base_url: http://127.0.0.1:${LLM_PORT}\n`);
  process.env.OPENROUTER_API_KEY = "test-key";
  core = new Core({ root, port: PORT, cli: [process.execPath, join(import.meta.dir, "../src/cli.ts")] });
  await core.start({ watch: false });
});
afterAll(async () => {
  // derive kicks off summaries without awaiting them; let them unwind before the run dirs disappear
  for (const r of core.runs.list()) if (r.status === "running" || r.status === "queued") core.runs.kill(r.id);
  await Bun.sleep(400);
  llm.stop(true); await core.close(); rmSync(root, { recursive: true, force: true });
});

test("openrouter drives derive, files overlap, and a folder is named only after everything under it", async () => {
  const r = await core.deriveAll("all").done;

  expect(fileCalls).toBe(FOLDERS.length);     // exactly one call per file — no folder-level splitting
  expect(folderCalls).toBe(FOLDERS.length);   // and one naming call per folder
  expect(r.created.length).toBeGreaterThan(0);
  expect(core.runs.list().some((x) => x.provider === "openrouter:stub-model" && x.status === "done")).toBe(true);

  // independent files overlapped — serial derive would peak at 1
  expect(peak).toBeGreaterThan(1);

  // a folder's naming call starts only once its own file and every subfolder below it has finished
  for (const f of FOLDERS) {
    expect(endedAt[`f:${fileIn(f)}`]).toBeLessThan(startedAt[`d:${f}`]);
    for (const child of FOLDERS.filter((c) => c !== f && (f === "" ? !c.includes("/") : c.startsWith(f + "/"))))
      expect(endedAt[`d:${child}`]).toBeLessThan(startedAt[`d:${f}`]);
  }

  // and the folder prompt actually carried what was described inside it
  const srcIntent = core.store.all().find((n) => n.kind === "intent" && n.folder === "src");
  expect(srcIntent?.spec).toContain("Folder src/a");
  expect(srcIntent?.spec).toContain("Behavior src/mod.ts");
}, 30_000);

test("a second derive with reset=all tears the tree down and rebuilds it with nothing stranded", async () => {
  const before = core.store.all().filter((n) => n.derived).length;
  expect(before).toBeGreaterThan(9);

  const r = await core.deriveAll("all").done;

  expect(r.created.length).toBeGreaterThan(0);
  for (const n of core.store.all()) if (n.parent) expect(core.store.get(n.parent)).not.toBeNull();
  // every symbol the index knows about ended up owned — the sweep guarantees derive leaves no orphans behind
  expect(core.orphans().orphan_count).toBe(0);
}, 30_000);
