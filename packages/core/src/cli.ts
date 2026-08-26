#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Core } from "./core.ts";
import { initProject, loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import { runCommand } from "./verify/examples.ts";

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--root", "--port", "--run", "--note", "--parent"]);
const flags = new Map<string, string>(); const bools = new Set<string>(); const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) { flags.set(a, argv[++i] ?? ""); }
  else if (a.startsWith("--")) bools.add(a);
  else words.push(a);
}
const cmd = words[0];
const flag = (name: string, def?: string) => flags.get(name) ?? def;
const has = (name: string) => bools.has(name);
const positional = words.slice(1);

function findRoot(): string {
  let d = resolve(flag("--root", process.env.LENZGRAPH_ROOT ?? process.cwd())!);
  const start = d;
  while (true) { if (existsSync(join(d, ".lenzgraph"))) return d; const p = resolve(d, ".."); if (p === d) return start; d = p; }
}
const root = findRoot();
const port = Number(flag("--port", process.env.LENZGRAPH_PORT ?? String(loadConfig(root).port)));
const api = async (path: string, body?: any, method = body ? "POST" : "GET") => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const daemonUp = async () => { try { await api("/status"); return true; } catch { return false; } };
const usage = `lenzgraph — agent dev kit

  lenzgraph init                         create .lenzgraph/ in the current project
  lenzgraph serve [--port N] [--no-watch] start the daemon + GUI (http://localhost:${port})
  lenzgraph index [--scip]               (re)build structure.db; --scip runs scip-typescript if installed
  lenzgraph derive                       brownfield: derive proposed nodes bottom-up (needs daemon)
  lenzgraph propose <file> [--parent id] greenfield: turn a brain-dump file into proposed nodes (needs daemon)
  lenzgraph dispatch <node>              build a node with an agent (needs daemon)
  lenzgraph verify <node>                execute a node's examples + machine check (needs daemon)
  lenzgraph lock acquire|release <file> --run <id>
  lenzgraph node set <id> <path> <value> set a field in a node (path may address examples by id)
  lenzgraph status
`;

async function main() {
  switch (cmd) {
    case "init": { const d = initProject(root); console.log(`initialized ${relative(process.cwd(), d) || "."}`); return; }
    case "serve": {
      const core = new Core({ root, port, cli: [process.execPath, resolve(import.meta.path)] });
      core.bus.on("log", (e) => console.log(`[${e.data.level}] ${e.data.msg}`));
      core.bus.on("run.updated", (e) => console.log(`[run] ${e.data.run.id} ${e.data.run.kind} ${e.data.run.node ?? ""} → ${e.data.run.status}`));
      core.bus.on("drift.detected", (e) => console.log(`[drift] ${e.data.id}: ${e.data.reasons.join("; ")}`));
      core.bus.on("lock.changed", (e) => console.log(`[lock] ${e.data.event.kind} ${e.data.event.file} ${e.data.event.run}${e.data.event.from ? " from " + e.data.event.from : ""}`));
      await core.start({ watch: !has("--no-watch") });
      const staticDir = resolve(import.meta.dir, "../static");
      startServer(core, staticDir);
      console.log(`lenzgraph serving ${root} at http://localhost:${port}`);
      return;
    }
    case "index": {
      if (has("--scip")) {
        const r = await runCommand("scip-typescript index", root, 600);
        if (r.exit !== 0) console.error(`scip-typescript failed (${r.exit}): ${r.stderr.slice(-500)}`); else console.log("index.scip written");
      }
      if (await daemonUp()) { const ev = await api("/index", {}); console.log(`synced via daemon: +${ev.added.length} ~${ev.changed.length} -${ev.removed.length}`); return; }
      const core = new Core({ root, port });
      const ev = await core.idx.indexAll();
      const scip = core.idx.applyScip();
      console.log(`indexed ${core.idx.db.allFiles().length} files, ${core.idx.db.allSymbols().length} symbols, ${core.idx.db.allRefs().length} refs${scip !== null ? ` (${scip} from scip)` : ""}; +${ev.added.length} ~${ev.changed.length} -${ev.removed.length}`);
      await core.close(); return;
    }
    case "status": { console.log(JSON.stringify(await api("/status"), null, 2)); return; }
    case "derive": { const r = await api("/derive", {}); console.log(`derived ${r.created.length} proposed nodes`); return; }
    case "propose": { const f = positional[0]; if (!f) throw new Error("propose <file>"); const r = await api("/propose", { text: readFileSync(f, "utf8"), parent: flag("--parent") ?? null }); console.log(`proposed ${r.created.length} nodes`); return; }
    case "dispatch": { const n = await api(`/nodes/${positional[0]}/dispatch`, { note: flag("--note") }); console.log(`${n.id} → ${n.status} (run ${n.last_run})`); return; }
    case "verify": { const n = await api(`/nodes/${positional[0]}/verify`, {}); console.log(JSON.stringify(n.verification, null, 2)); return; }
    case "lock": {
      const sub = positional[0]; const file = positional[1]; const run = flag("--run", process.env.LENZGRAPH_RUN);
      if (!file || !run) throw new Error("lock acquire|release <file> --run <id>");
      const rel = relative(root, resolve(file)).split("\\").join("/");
      const r = await api(`/locks/${sub === "release" ? "release" : "acquire"}`, { file: rel, run });
      console.log(JSON.stringify(r)); if (r.granted === false) process.exit(2); return;
    }
    case "node": {
      if (positional[0] !== "set") throw new Error("node set <id> <path> <value>");
      const [, id, path, ...rest] = positional; const value = rest.join(" ");
      const n = await api(`/nodes/${id}/set`, { path, value });
      console.log(`${n.id}.${path} set`); return;
    }
    case "hook": { await hook(positional[0]); return; }
    default: console.log(usage); if (cmd && cmd !== "help") process.exit(1);
  }
}

/** Claude Code hook entry points (stdin = hook JSON). */
async function hook(sub: string) {
  const run = flag("--run", process.env.LENZGRAPH_RUN)!;
  const input = JSON.parse(await Bun.stdin.text().catch(() => "{}") || "{}");
  const fp: string | undefined = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const rel = fp ? relative(root, resolve(input.cwd ?? root, fp)).split("\\").join("/") : null;
  const emit = (o: any) => { process.stdout.write(JSON.stringify(o)); };
  try {
    if (sub === "pre") {
      if (!rel || rel.startsWith("..")) return;
      const r = await api("/locks/acquire", { file: rel, run });
      const ctx = r.notices?.length ? r.notices.join("\n") : undefined;
      if (!r.granted) { emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `lenzgraph lock denied: ${r.reason}` } }); return; }
      if (ctx) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: ctx }, additionalContext: ctx });
    } else if (sub === "post") {
      if (rel) await api("/locks/touch", { file: rel, run });
    } else if (sub === "notices") {
      const r = await api("/locks/notices", { run });
      if (r.notices?.length) { const ctx = r.notices.join("\n"); emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: ctx }, additionalContext: ctx }); }
    }
  } catch (e) {
    // broker unreachable → fail open (never wedge the agent), but say so
    process.stderr.write(`lenzgraph hook: ${e}\n`);
  }
}

main().catch((e) => { console.error(`error: ${e.message ?? e}`); process.exit(1); });
