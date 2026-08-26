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
  let d = resolve(flag("--root", process.env.LENZ_ROOT ?? process.cwd())!);
  const start = d;
  while (true) { if (existsSync(join(d, ".lenz"))) return d; const p = resolve(d, ".."); if (p === d) return start; d = p; }
}
const root = findRoot();
const port = Number(flag("--port", process.env.LENZ_PORT ?? String(loadConfig(root).port)));
const api = async (path: string, body?: any, method = body ? "POST" : "GET") => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j;
};
const daemonUp = async () => { try { await api("/status"); return true; } catch { return false; } };
const usage = `lenz — agent dev kit

  lenz init                         create .lenz/ in the current project
  lenz serve [--port N] [--no-watch] start the daemon + GUI (http://localhost:${port})
  lenz index [--scip]               (re)build structure.db; --scip runs scip-typescript if installed
  lenz derive                       brownfield: derive proposed nodes bottom-up (needs daemon)
  lenz propose <file> [--parent id] greenfield: turn a brain-dump file into proposed nodes (needs daemon)
  lenz dispatch <node>              build a node with an agent (needs daemon)
  lenz verify <node>                execute a node's examples + machine check (needs daemon)
  lenz lock acquire|release <file> --run <id>
  lenz node set <id> <path> <value> set a field in a node (path may address examples by id)
  lenz summarize [--force]          write relational summaries for nodes (needs daemon)
  lenz status
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
      console.log(`lenz serving ${root} at http://localhost:${port}`);
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
    case "summarize": { await api("/summarize", { force: has("--force") }); console.log("summarizing in the background; watch the daemon log"); return; }
    case "status": { console.log(JSON.stringify(await api("/status"), null, 2)); return; }
    case "derive": { const r = await api("/derive", {}); console.log(`derived ${r.created.length} proposed nodes`); return; }
    case "propose": { const f = positional[0]; if (!f) throw new Error("propose <file>"); const r = await api("/propose", { text: readFileSync(f, "utf8"), parent: flag("--parent") ?? null }); console.log(`proposed ${r.created.length} nodes`); return; }
    case "dispatch": { const n = await api(`/nodes/${positional[0]}/dispatch`, { note: flag("--note") }); console.log(`${n.id} → ${n.status} (run ${n.last_run})`); return; }
    case "verify": { const n = await api(`/nodes/${positional[0]}/verify`, {}); console.log(JSON.stringify(n.verification, null, 2)); return; }
    case "lock": {
      const sub = positional[0]; const file = positional[1]; const run = flag("--run", process.env.LENZ_RUN);
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
  const run = flag("--run", process.env.LENZ_RUN)!;
  const input = JSON.parse(await Bun.stdin.text().catch(() => "{}") || "{}");
  const toRel = (fp: string) => relative(root, resolve(input.cwd ?? root, fp)).split("\\").join("/");
  const fp: string | undefined = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  const files: string[] = fp ? [toRel(fp)] : input.tool_name === "Bash" ? bashWriteTargets(String(input.tool_input?.command ?? ""), input.cwd ?? root).map(toRel) : [];
  const inRepo = files.filter((f) => f && !f.startsWith("..") && !f.startsWith(".lenz/"));
  const emit = (o: any) => { process.stdout.write(JSON.stringify(o)); };
  try {
    if (sub === "pre") {
      let notices: string[] = [];
      if (!inRepo.length) { const r = await api("/locks/notices", { run }); notices = r.notices ?? []; }
      for (const f of inRepo) {
        const r = await api("/locks/acquire", { file: f, run });
        notices.push(...(r.notices ?? []));
        if (!r.granted) { emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `lenz lock denied: ${r.reason}` } }); return; }
      }
      if (notices.length) { const ctx = notices.join("\n"); emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: ctx }, additionalContext: ctx }); }
    } else if (sub === "post") {
      for (const f of inRepo) await api("/locks/touch", { file: f, run });
    } else if (sub === "notices") {
      const r = await api("/locks/notices", { run });
      if (r.notices?.length) { const ctx = r.notices.join("\n"); emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: ctx }, additionalContext: ctx }); }
    }
  } catch (e) {
    // broker unreachable → fail open (never wedge the agent), but say so
    process.stderr.write(`lenz hook: ${e}\n`);
  }
}

/**
 * Heuristic: which repo files does a shell command write? Only used when the agent bypasses Write/Edit.
 * If the command carries a write indicator, every quoted/bare path token that exists on disk (or sits under an
 * existing directory) is treated as a write target.
 */
export function bashWriteTargets(cmd: string, cwd: string): string[] {
  const writeIndicators = /(^|[^<>])>{1,2}\s*[^&\s]|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\bmv\b|\bcp\b|\brm\b|\bopen\([^)]*['"](w|a|r\+)|\.write\(|\bwriteFile|\btouch\b|\bpatch\b|\bgit\s+(apply|checkout|stash)\b|\bmkdir\b/;
  if (!writeIndicators.test(cmd)) return [];
  const out = new Set<string>();
  for (const m of cmd.matchAll(/[\w.\/-]*\.(ts|tsx|js|jsx|mjs|cjs|py|go|json|md|yaml|yml|toml|css|html)\b/g)) {
    const tok = m[0];
    if (tok.startsWith("-") || tok.includes("://")) continue;
    const abs = resolve(cwd, tok);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (existsSync(abs) || existsSync(dir)) out.add(abs);
  }
  return [...out];
}

main().catch((e) => { console.error(`error: ${e.message ?? e}`); process.exit(1); });
