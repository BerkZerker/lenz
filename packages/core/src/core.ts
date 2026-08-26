import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { StructureIndex, anchorKey, flowFrom, resolveAnchor, toAnchor, type Anchor, type SymbolRow, type SymbolsChanged } from "@lenz/structure";
import { initProject, lenzDir, loadConfig, type LenzConfig } from "./config.ts";
import { EventBus } from "./events.ts";
import { LockBroker } from "./locks.ts";
import { FanOutError, NodeStore, newId, FAN_OUT_CAP } from "./nodes.ts";
import { RunManager } from "./runs/manager.ts";
import { BEHAVIOR_SCHEMA, DERIVE_SCHEMA, PROPOSAL_SCHEMA, behaviorPrompt, buildPrompt, comparePrompt, derivePrompt, oneLine, proposePrompt, reconstructPrompt, summaryPrompt } from "./runs/prompt.ts";
import { computeRelations, type NodeRelations } from "./relations.ts";
import { runCommand, runExamples } from "./verify/examples.ts";
import { loadEnvFiles } from "./llm/gemini.ts";
import { EDITABLE_FIELDS, type Example, type LenzNode, type NodeStatus, type ProposedAnchor } from "./types.ts";

export interface CoreOpts { root: string; port?: number; cli?: string[] }
export type DeriveReset = "none" | "proposed" | "all";
export interface DeriveProgress { scope: string; total: number; done: number; current: string; started_at: string }

export class Core {
  root: string; dir: string; cfg: LenzConfig; bus = new EventBus();
  idx: StructureIndex; store: NodeStore; locks: LockBroker; runs: RunManager;
  immediate = false;
  port: number;
  private relCache: { at: number; data: Record<string, NodeRelations> } | null = null;
  private summarizing = new Set<string>();
  deriving: DeriveProgress | null = null;
  cli: string[];

  constructor(opts: CoreOpts) {
    this.root = opts.root; this.dir = initProject(opts.root); this.cfg = loadConfig(opts.root);
    loadEnvFiles([join(this.root, ".env"), join(this.dir, ".env")]); // <project>/.env (standard) or .lenz/.env
    if (this.cfg.llm.provider === "gemini" && !process.env.GEMINI_API_KEY) { this.cfg.llm = { provider: "claude", model: "" }; }
    this.port = opts.port ?? this.cfg.port;
    this.cli = opts.cli ?? ["bun", join(import.meta.dir, "cli.ts")];
    this.idx = new StructureIndex({ root: this.root, dbPath: join(this.dir, "structure.db"), source_globs: this.cfg.source_globs, ignore_globs: this.cfg.ignore_globs, entry_globs: this.cfg.entry_globs, orphan_exclude: this.cfg.orphan_exclude });
    this.store = new NodeStore(join(this.dir, "nodes"), this.idx.db, this.bus);
    this.locks = new LockBroker(this.bus, () => this.cfg.lock_cooldown);
    this.runs = new RunManager({ root: this.root, lenzDir: this.dir, runsDir: join(this.dir, "runs"), port: this.port, cli: this.cli, maxConcurrent: () => this.cfg.max_concurrent_runs, timeoutSec: () => this.cfg.run_timeout, model: () => this.cfg.model, llm: () => this.cfg.llm }, this.bus, this.locks, this.idx);
    this.idx.on("symbols_changed", (ev: SymbolsChanged) => { this.relCache = null; this.bus.publish("structure.synced", ev); this.detectDrift(ev); });
    this.bus.on("node.updated", () => { this.relCache = null; });
    this.bus.on("node.deleted", () => { this.relCache = null; });
    this.idx.on("error", (e: any) => this.bus.publish("log", { level: "error", msg: String(e) }));
  }

  async start(opts: { watch?: boolean } = { watch: true }) {
    await this.idx.indexAll();
    const scip = this.idx.applyScip();
    if (scip !== null) this.log(`applied ${scip} precise references from index.scip`);
    this.store.load();
    this.refreshAllAnchors();
    if (opts.watch) this.idx.watch();
    this.log(`indexed ${this.idx.db.allFiles().length} files, ${this.idx.db.allSymbols().length} symbols; ${this.store.all().length} nodes; llm: ${this.cfg.llm.provider === "gemini" ? this.cfg.llm.model : "claude code"} (builds: claude code)`);
  }
  async close() { await this.idx.close(); }
  log(msg: string, level = "info") { this.bus.publish("log", { level, msg }); }
  cliCommand() { return this.cli.map((s) => (/\s/.test(s) ? `'${s}'` : s)).join(" "); }

  // ---------- nodes ----------
  putNode(id: string, patch: Partial<LenzNode>) {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    const allowed: Partial<LenzNode> = {};
    for (const f of EDITABLE_FIELDS) if (f in patch) (allowed as any)[f] = (patch as any)[f];
    if (allowed.examples) allowed.examples = allowed.examples.map((e, i) => ({ ...e, id: e.id || `ex_${newId("").slice(1)}` }));
    const specChanged = (allowed.spec !== undefined && allowed.spec !== n.spec) || (allowed.examples !== undefined && JSON.stringify(allowed.examples) !== JSON.stringify(n.examples));
    if (specChanged && n.kind === "behavior" && n.status !== "proposed") allowed.staged = true;
    const out = this.store.update(id, allowed);
    if (specChanged) this.bus.publish("staging.changed", this.staging());
    if (allowed.staged && this.immediate) void this.confirmStaging();
    return out;
  }
  createNode(partial: Partial<LenzNode> & { title: string; kind: LenzNode["kind"] }) { return this.store.create({ ...partial, status: partial.status ?? "specified" }); }
  deleteNode(id: string) { this.store.delete(id); }

  /** `lenz node set <id> <path> <value>` — path segments may address array items by id. */
  nodeSet(id: string, path: string, rawValue: string) {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    let value: any; try { value = YAML.parse(rawValue); } catch { value = rawValue; }
    if (typeof value !== "string" && /^[a-z]/i.test(rawValue) && rawValue.includes(" ")) value = rawValue; // keep shell commands as strings
    const segs = path.split(".");
    let cur: any = n;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (Array.isArray(cur)) { const hit = cur.find((x: any) => x?.id === s) ?? cur[Number(s)]; if (!hit) throw new Error(`no element ${s} in ${segs.slice(0, i).join(".")}`); cur = hit; }
      else { if (cur[s] == null) cur[s] = /^\d+$/.test(segs[i + 1]) ? [] : {}; cur = cur[s]; }
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(cur)) { const i = cur.findIndex((x: any) => x?.id === last); if (i >= 0) cur[i] = value; else cur[Number(last)] = value; }
    else cur[last] = value;
    this.store.save(n);
    return n;
  }

  approve(id: string, by = "human") {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    if (n.status === "proposed") {
      this.store.setStatus(id, "specified");
      for (const d of this.store.descendants(id)) if (d.status === "proposed") this.store.setStatus(d.id, "specified");
      return this.store.get(id);
    }
    if (n.status === "built" || n.status === "rejected" || n.status === "drifted") {
      const v = { ...(n.verification ?? {}), approved_by: by, approved_at: new Date().toISOString() };
      delete v.rejection_note;
      return this.store.update(id, { status: "verified", verification: v, needs_reverify: false, prev_status: undefined, drift: undefined });
    }
    throw new Error(`cannot approve node in status ${n.status}`);
  }
  reject(id: string, note: string, redispatch = true) {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    if (n.status === "proposed") { this.store.delete(id); return null; }
    this.store.update(id, { status: "rejected", verification: { ...(n.verification ?? {}), rejection_note: note } });
    if (redispatch) return this.dispatch(id, note);
    return this.store.get(id);
  }

  // ---------- anchors / drift ----------
  refreshAllAnchors() {
    for (const n of this.store.all()) if (n.kind === "behavior" && n.anchors?.length && n.status !== "building") this.refreshAnchors(n, false);
  }
  /** Re-resolve anchors; silently re-anchor moved/renamed, flag drift for changed/deleted. */
  refreshAnchors(n: LenzNode, flag = true) {
    const reasons: string[] = []; let dirty = false;
    const next: Anchor[] = [];
    for (const a of n.anchors ?? []) {
      const r = resolveAnchor(this.idx.db, a);
      if (r.status === "moved" || r.status === "renamed") { dirty = true; next.push(r.anchor); }
      else if (r.status === "changed") { reasons.push(`${a.name} in ${a.file} changed`); next.push(a); }
      else if (r.status === "deleted") { reasons.push(`${a.name} in ${a.file} deleted`); next.push(a); }
      else next.push(a);
    }
    if (dirty) { n.anchors = next; this.store.save(n, { silent: true }); }
    if (reasons.length && flag && n.status !== "building" && n.status !== "drifted" && n.status !== "proposed") {
      this.store.update(n.id, { status: "drifted", prev_status: n.status, drift: { reasons, at: new Date().toISOString() } });
      this.bus.publish("drift.detected", { id: n.id, reasons });
    }
    return reasons;
  }
  detectDrift(ev: SymbolsChanged) {
    const touched = new Set([...ev.added, ...ev.changed, ...ev.removed].map((k) => k.split("#")[0]));
    const building = this.runs.buildingNodes();
    for (const n of this.store.all()) {
      if (n.kind !== "behavior" || !n.anchors?.length || building.has(n.id)) continue;
      if (!n.anchors.some((a) => touched.has(a.file))) continue;
      this.refreshAnchors(n, true);
    }
  }
  resolveDrift(id: string, action: "holds" | "rebuild") {
    const n = this.store.get(id); if (!n || n.status !== "drifted") throw new Error("node is not drifted");
    if (action === "holds") {
      // accept the new code as the anchored code
      const anchors = (n.anchors ?? []).map((a) => { const s = this.idx.db.symbol(anchorKey(a)); return s ? toAnchor(s) : null; }).filter((a): a is Anchor => !!a);
      return this.store.update(id, { status: n.prev_status ?? "verified", prev_status: undefined, drift: undefined, anchors });
    }
    return this.dispatch(id, `Code drifted from spec: ${n.drift?.reasons.join("; ")}`);
  }

  // ---------- staging / blast radius ----------
  staging() {
    const staged = this.store.all().filter((n) => n.staged);
    const ids = new Set(staged.map((n) => n.id));
    const blast = new Set<string>();
    for (const n of this.store.all()) if (n.deps.some((d) => ids.has(d))) blast.add(n.id);
    const keys = staged.flatMap((n) => (n.anchors ?? []).map(anchorKey));
    for (const o of this.idx.db.neighborOwners(keys)) blast.add(o);
    for (const id of ids) blast.delete(id);
    return { staged: staged.map((n) => n.id), blast: [...blast], immediate: this.immediate };
  }
  async confirmStaging() {
    const s = this.staging();
    for (const id of s.blast) { const n = this.store.get(id)!; if (!n.needs_reverify) this.store.update(id, { needs_reverify: true }); }
    const order = this.store.topo(s.staged);
    const dispatched: string[] = [];
    for (const n of order) {
      this.store.update(n.id, { staged: false });
      if (n.kind === "behavior") { this.dispatch(n.id); dispatched.push(n.id); }
    }
    this.bus.publish("staging.changed", this.staging());
    return { dispatched };
  }
  setImmediate(v: boolean) { this.immediate = v; this.bus.publish("staging.changed", this.staging()); if (v) void this.confirmStaging(); }

  // ---------- dispatch / build → verify ----------
  dispatch(id: string, note?: string) {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    if (n.kind !== "behavior") throw new Error("only behavior nodes are dispatched");
    if (this.runs.runningFor(id)) throw new Error(`node ${id} already has a run`);
    const prompt = buildPrompt(n, this.store, this.idx, { root: this.root, lenzDir: this.dir, cliCommand: this.cliCommand(), runId: "" }, note ?? n.verification?.rejection_note);
    const { id: runId, done } = this.runs.submit({ kind: "build", node: id, prompt, note });
    this.store.update(id, { status: "building", last_run: runId, staged: false });
    void done.then((o) => this.onBuildDone(id, o.run.id, o.run.status)).catch((e) => this.log(`build ${runId} failed: ${e}`, "error"));
    return this.store.get(id);
  }

  private async onBuildDone(nodeId: string, runId: string, status: string) {
    const n = this.store.get(nodeId); if (!n) return;
    if (status === "killed") { this.store.update(nodeId, { status: n.prev_status && n.prev_status !== "building" ? "specified" : "specified" }); return; }
    // proposed anchors from the watcher's view of the run window
    const changes = this.runs.changesFor(runId);
    const proposed: ProposedAnchor[] = [];
    for (const c of changes) {
      const s = this.idx.db.symbol(c.key);
      if (this.idx.isOrphanExcluded(c.key.split("#")[0])) continue;
      if (s) proposed.push({ ...toAnchor(s), change: c.change as any, owner: this.idx.db.ownersOf(c.key).find((o) => o !== nodeId) ?? null });
      else if (c.change === "removed") { const p = c.key.split("#"); proposed.push({ kind: p[2] as any, name: p.slice(3).join("#"), container: p[1], file: p[0], sig: "", body: "", change: "removed" }); }
    }
    // refresh anchors of this node (its code was supposed to change) and drop deleted ones
    const anchors = (n.anchors ?? []).map((a) => { const r = resolveAnchor(this.idx.db, a); return r.status === "deleted" ? null : r.anchor; }).filter((a): a is Anchor => !!a);
    // auto-adopt: symbols this run added/changed that nobody else owns become anchors immediately (human can drop them in Verify)
    for (const p of proposed) if (p.change !== "removed" && !p.owner && !anchors.some((a) => anchorKey(a) === anchorKey(p))) anchors.push({ kind: p.kind, name: p.name, container: p.container, file: p.file, sig: p.sig, body: p.body });
    this.store.update(nodeId, { status: "built", anchors, proposed_anchors: proposed, prev_status: undefined, drift: undefined });
    await this.verify(nodeId);
    void this.summarize(nodeId).catch((e) => this.log(String(e), "warn"));
  }

  /** Execute examples + machine check, then dispatch blind reconstruction. */
  async verify(nodeId: string) {
    const n = this.store.get(nodeId); if (!n) throw new Error("unknown node");
    const results = await runExamples(n.examples ?? [], this.root, this.cfg.example_timeout, () => {});
    const pass = results.filter((r) => r.pass === true).length, fail = results.filter((r) => r.pass === false).length, pending = results.filter((r) => r.pass === null).length;
    const v = { ...(this.store.get(nodeId)!.verification ?? {}), examples: { pass, fail, pending, at: new Date().toISOString(), results } };
    this.store.update(nodeId, { verification: v });
    if (n.machine?.run) {
      const out = await runCommand(n.machine.run, this.root, this.cfg.example_timeout * 3);
      const tail = (out.stdout + "\n" + out.stderr).trim().split("\n").slice(-40).join("\n");
      this.store.update(nodeId, { verification: { ...(this.store.get(nodeId)!.verification ?? {}), machine: { ok: out.exit === 0, exit: out.exit ?? -1, tail, at: new Date().toISOString() } } });
    }
    void this.reconstruct(nodeId).catch((e) => this.log(`reconstruction failed: ${e}`, "error"));
    return this.store.get(nodeId);
  }
  markExample(nodeId: string, exampleId: string, pass: boolean) {
    const n = this.store.get(nodeId)!; const v = n.verification?.examples; if (!v) throw new Error("no example results");
    const r = v.results.find((x) => x.id === exampleId); if (!r) throw new Error("unknown example");
    r.pass = pass; r.note = "marked by human";
    v.pass = v.results.filter((x) => x.pass === true).length; v.fail = v.results.filter((x) => x.pass === false).length; v.pending = v.results.filter((x) => x.pass === null).length;
    return this.store.save(n);
  }

  /** Blind reconstruction: fresh run sees only the anchored source; a second run compares it to the spec. */
  async reconstruct(nodeId: string) {
    const n = this.store.get(nodeId); if (!n) throw new Error("unknown node");
    const anchors = n.anchors ?? [];
    if (!anchors.length) { this.store.update(nodeId, { verification: { ...(n.verification ?? {}), reconstruction: { verdict: "error", reasons: ["no anchored symbols"], at: new Date().toISOString() } } }); return; }
    const sources = anchors.map((a) => ({ header: `${a.file} — ${a.kind} ${a.container ? a.container + "." : ""}${a.name}`, text: this.idx.symbolSource(anchorKey(a)) ?? "" })).filter((s) => s.text);
    const keys = new Set(anchors.map(anchorKey));
    const callees = new Set<string>();
    for (const k of keys) for (const r of this.idx.db.refsFrom(k)) if (!keys.has(r.dst_key)) { const s = this.idx.db.symbol(r.dst_key); if (s) callees.add(`${s.kind} ${s.name} (${s.file}): ${oneLine(this.idx.symbolSource(s.key)?.split("{")[0] ?? "", 120)}`); }
    const r1 = await this.runs.submit({ kind: "reconstruct", node: nodeId, prompt: reconstructPrompt(sources, [...callees]), extra: ["--tools", ""], light: true }).done;
    const text = r1.text.trim();
    if (!text) { this.store.update(nodeId, { verification: { ...(this.store.get(nodeId)!.verification ?? {}), reconstruction: { verdict: "error", reasons: [r1.run.error ?? "empty reconstruction"], at: new Date().toISOString() } } }); return; }
    this.store.update(nodeId, { reconstruction: text });
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["match", "mismatch"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["verdict", "reasons"] };
    const r2 = await this.runs.submit({ kind: "compare", node: nodeId, prompt: comparePrompt(n.spec, n.examples, text), extra: ["--tools", ""], schema, light: true }).done;
    const parsed = r2.structured ?? extractJson(r2.text);
    const verdict = parsed?.verdict === "match" || parsed?.verdict === "mismatch" ? parsed.verdict : "error";
    this.store.update(nodeId, { verification: { ...(this.store.get(nodeId)!.verification ?? {}), reconstruction: { verdict, reasons: Array.isArray(parsed?.reasons) ? parsed.reasons : [r2.run.error ?? "no verdict"], at: new Date().toISOString() } } });
  }

  /** Verify tab "Changes": assign proposed symbols to this node / another node / leave orphan. */
  assignAnchor(nodeId: string, key: string, owner: string | null) {
    const s = this.idx.db.symbol(key); if (!s) throw new Error("unknown symbol");
    const a = toAnchor(s);
    for (const n of this.store.all()) {
      if (n.kind !== "behavior") continue;
      const has = (n.anchors ?? []).some((x) => anchorKey(x) === key);
      if (n.id === owner && !has) this.store.update(n.id, { anchors: [...(n.anchors ?? []), a] });
      else if (n.id !== owner && has) this.store.update(n.id, { anchors: (n.anchors ?? []).filter((x) => anchorKey(x) !== key) });
    }
    const node = this.store.get(nodeId);
    if (node?.proposed_anchors) { for (const p of node.proposed_anchors) if (anchorKey(p) === key) p.owner = owner === nodeId ? null : owner; this.store.save(node); }
    return this.store.get(nodeId);
  }

  // ---------- orphans / flow ----------
  orphans() {
    const all = this.idx.db.orphans().filter((s) => !this.idx.isOrphanExcluded(s.file));
    const byFile = new Map<string, SymbolRow[]>();
    for (const s of all) { const a = byFile.get(s.file) ?? []; a.push(s); byFile.set(s.file, a); }
    const total = this.idx.db.allSymbols().filter((s) => !this.idx.isOrphanExcluded(s.file)).length;
    return { total_symbols: total, orphan_count: all.length, files: [...byFile].map(([file, symbols]) => ({ file, symbols })) };
  }
  /** every indexed file with its symbols and owning node (for the GUI file tree) */
  files() {
    const owner = new Map<string, string>(); for (const o of this.idx.db.ownedSymbols()) owner.set(o.key, o.node_id);
    return this.idx.db.allFiles().map((f) => ({ path: f.path, language: f.language, symbols: this.idx.db.symbolsInFile(f.path).map((s) => ({ key: s.key, kind: s.kind, name: s.name, container: s.container, start_line: s.start_line, owner: owner.get(s.key) ?? null })) }));
  }
  /** the anchor of a node that fans out the most — the natural place to start reading its execution flow */
  flowEntryFor(id: string): string | null {
    const n = this.store.get(id); if (!n) return null;
    let best: string | null = null, bestN = -1;
    for (const a of n.anchors ?? []) { const k = `${a.file}#${a.container}#${a.kind}#${a.name}`; const c = this.idx.db.refsFrom(k).length; if (c > bestN) { best = k; bestN = c; } }
    return best;
  }
  flow(from?: string) {
    const entries = this.idx.db.entryPoints().map((e) => ({ ...e, symbol: this.idx.db.symbol(e.key)! }));
    return { entries, tree: from ? flowFrom(this.idx.db, from) : null };
  }

  // ---------- greenfield: propose ----------
  async propose(text: string, parent: string | null = null) {
    const existing = this.store.tree();
    const treeText = renderTree(existing, this.store);
    const parentNode = parent ? this.store.get(parent) : null;
    let prompt = proposePrompt(text, treeText, parentNode?.title ?? null, this.cfg.llm.provider === "gemini" ? this.repoSummary() : null);
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await this.runs.submit({ kind: "propose", node: parent, prompt: attempt ? prompt + `\n\nYour previous proposal was rejected: ${lastErr}. Fix it.` : prompt, extra: ["--tools", "Read,Glob,Grep"], schema: PROPOSAL_SCHEMA, light: true }).done;
      const parsed = out.structured ?? extractJson(out.text);
      if (!parsed?.nodes) { lastErr = out.run.error ?? "no JSON tree in output"; continue; }
      const viol = fanOutViolation(parsed.nodes, this.store.children(parent).length);
      if (viol) { lastErr = viol; continue; }
      const created = this.materialize(parsed.nodes, parent, false);
      void this.summarizeAll(false).catch((e) => this.log(String(e), "warn"));
      return { created, attempt };
    }
    throw new Error(`proposal failed: ${lastErr}`);
  }
  private materialize(nodes: any[], parent: string | null, derived: boolean): string[] {
    const created: string[] = [];
    const byTitle = new Map<string, string>();
    const walk = (list: any[], p: string | null) => {
      const pending: { node: LenzNode; deps: string[] }[] = [];
      for (const raw of list) {
        const kind = raw.kind === "intent" ? "intent" : "behavior";
        const examples: Example[] | undefined = kind === "behavior" ? (raw.examples ?? []).map((e: any, i: number) => ({ id: `ex_${newId("").slice(1)}`, name: e.name ?? `example ${i + 1}`, given: e.given, when: e.when, then: e.then, expect: { mode: "exit0" }, ...(derived ? { derived: true } : {}) })) : undefined;
        const n = this.store.create({ kind, title: String(raw.title ?? "untitled").slice(0, 120), spec: String(raw.spec ?? ""), parent: p, status: "proposed", examples, derived: derived || undefined, anchors: kind === "behavior" && Array.isArray(raw.anchors) ? raw.anchors : undefined });
        created.push(n.id); byTitle.set(n.title.toLowerCase(), n.id);
        pending.push({ node: n, deps: Array.isArray(raw.deps) ? raw.deps : [] });
        if (Array.isArray(raw.children) && raw.children.length) walk(raw.children, n.id);
      }
      for (const { node, deps } of pending) {
        const ids = deps.map((d: string) => byTitle.get(String(d).toLowerCase())).filter((x): x is string => !!x && x !== node.id);
        if (ids.length) this.store.update(node.id, { deps: ids });
      }
    };
    walk(nodes, parent);
    return created;
  }

  // ---------- brownfield: derive ----------
  /** Folder a derived intent stands for: recorded at derive time, else the common directory of its descendants' anchors. */
  folderOf(n: LenzNode): string | null {
    if (n.folder !== undefined) return n.folder;
    const dirs = this.store.anchorsOf(n.id).map((a) => (dirname(a.file) === "." ? "" : dirname(a.file)));
    if (!dirs.length) return null;
    let common = dirs[0].split("/");
    for (const d of dirs.slice(1)) { const parts = d.split("/"); let i = 0; while (i < common.length && common[i] === parts[i]) i++; common = common.slice(0, i); }
    return common.join("/");
  }
  private derivedIn(subtreeRoot: string | null, scope: DeriveReset) {
    const pool = subtreeRoot ? this.store.descendants(subtreeRoot) : this.store.all();
    return pool.filter((n) => n.derived && (scope === "all" || n.status === "proposed"));
  }
  /** Drop derived nodes (non-recursively: hand-authored / kept children float up to the nearest surviving ancestor). */
  private resetDerived(subtreeRoot: string | null, scope: DeriveReset) {
    const victims = this.derivedIn(subtreeRoot, scope);
    for (const v of victims) if (this.store.get(v.id)) this.store.delete(v.id, false);
    return victims.length;
  }
  /** Regenerate the whole graph from code. `reset` decides which existing derived nodes are thrown away first. */
  deriveAll(reset: DeriveReset = "none") {
    return this.runDerive("graph", () => { this.resetDerived(null, reset); return { dirs: this.allDirs(), parent: null, parentDir: null }; });
  }
  /** Regenerate one node: an intent re-derives its folder subtree, a behavior rewrites its title/spec/examples from its anchors. */
  deriveNode(id: string, reset: DeriveReset = "none") {
    const n = this.store.get(id); if (!n) throw new Error(`unknown node ${id}`);
    if (n.kind === "behavior") return this.regenerateBehavior(id);
    const folder = this.folderOf(n); if (folder === null) throw new Error(`${n.title} has no folder to derive from (no derived symbols underneath it)`);
    return this.runDerive(n.title, () => {
      this.resetDerived(id, reset);
      const dirs = this.allDirs().filter((d) => d === folder || (folder === "" ? true : d.startsWith(folder + "/")));
      return { dirs, parent: n.parent, parentDir: folder };
    });
  }
  private allDirs(): string[] {
    const files = this.idx.db.allFiles().map((f) => f.path).filter((f) => !this.idx.isOrphanExcluded(f));
    const all = new Set<string>();
    for (const f of files) { let d = dirname(f) === "." ? "" : dirname(f); all.add(d); while (d) { d = dirname(d) === "." ? "" : dirname(d); all.add(d); } }
    return [...all];
  }
  private runDerive(scope: string, plan: () => { dirs: string[]; parent: string | null; parentDir: string | null }) {
    if (this.deriving) throw new Error(`already deriving (${this.deriving.scope})`);
    this.deriving = { scope, total: 0, done: 0, current: "", started_at: new Date().toISOString() };
    const progress = () => this.bus.publish("derive.progress", this.deriving);
    progress();
    const done = (async () => {
      try {
        const { dirs, parent, parentDir } = plan();
        const r = await this.derive(dirs, parent, parentDir, (d, i, total) => { this.deriving = { ...this.deriving!, current: d === null ? "" : d || ".", done: i, total }; progress(); });
        this.deriving = { ...this.deriving!, done: this.deriving!.total, current: "" };
        this.log(`derived ${r.created.length} proposed nodes (${scope})`);
        return r;
      } catch (e) { this.log(`derive failed: ${e}`, "error"); throw e; }
      finally { this.deriving = null; this.bus.publish("derive.progress", null); }
    })();
    done.catch(() => {});
    return { started: true, scope, done };
  }
  /**
   * Bottom-up: one LLM call per folder over its still-orphan symbols, plus one intent per folder. Existing derived intents
   * for a folder are reused (title/spec refreshed only while still `proposed`) so approved work survives a re-run.
   */
  async derive(dirs: string[], parent: string | null = null, rootDir: string | null = null, onProgress?: (dir: string | null, i: number, total: number) => void) {
    const files = this.idx.db.allFiles().map((f) => f.path).filter((f) => !this.idx.isOrphanExcluded(f));
    const folders = new Map<string, string[]>();
    for (const f of files) { const d = dirname(f) === "." ? "" : dirname(f); const a = folders.get(d) ?? []; a.push(f); folders.set(d, a); }
    const order = [...new Set(dirs)].sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b)); // deepest first
    const intentByDir = new Map<string, LenzNode>();
    for (const n of this.store.all()) if (n.kind === "intent" && n.derived) { const d = this.folderOf(n); if (d !== null && !intentByDir.has(d)) intentByDir.set(d, n); }
    const created: string[] = [];
    const orphanKeys = new Set(this.idx.db.orphans().map((s) => s.key));
    const subsOf = (dir: string) => [...intentByDir].filter(([d]) => d !== dir && (dir === "" ? !d.includes("/") : d.startsWith(dir + "/") && !d.slice(dir.length + 1).includes("/"))).map(([, n]) => n);
    const work = order.filter((dir) => (folders.get(dir) ?? []).some((f) => this.idx.db.symbolsInFile(f).some((s) => orphanKeys.has(s.key))) || subsOf(dir).length);
    let i = 0;
    for (const dir of work) {
      const syms = (folders.get(dir) ?? []).flatMap((f) => this.idx.db.symbolsInFile(f)).filter((s) => orphanKeys.has(s.key));
      const subs = subsOf(dir);
      onProgress?.(dir, i++, work.length);
      this.log(`deriving ${dir || "."} (${syms.length} symbols, ${subs.length} subfolders)`);
      const existing = intentByDir.get(dir);
      const intentParent = dir === rootDir || dir === "" ? parent : null; // deeper intents are reparented by their folder's intent below
      let intent: LenzNode;
      if (!syms.length) {
        intent = existing ?? this.store.create({ kind: "intent", title: dir.split("/").pop() || "project", spec: `Folder ${dir || "."}: ${subs.map((s) => s.title).join(", ")}`, status: "proposed", derived: true, folder: dir, parent: intentParent });
      } else {
        const symInfo = syms.map((s) => ({ key: s.key, kind: s.kind, name: s.name, container: s.container, file: s.file, sig: (this.idx.symbolSource(s.key) ?? "").split("\n")[0].slice(0, 160), doc: docOf(this.idx, s) }));
        const out = await this.runs.submit({ kind: "derive", node: null, prompt: derivePrompt(dir, symInfo, subs.map((s) => ({ title: s.title, spec: s.spec }))), extra: ["--tools", ""], schema: DERIVE_SCHEMA, light: true }).done;
        const parsed = out.structured ?? extractJson(out.text);
        if (!parsed?.intent) { this.log(`derive ${dir}: no output (${out.run.error ?? "empty"})`, "warn"); continue; }
        const title = String(parsed.intent.title ?? dir).slice(0, 120), spec = String(parsed.intent.spec ?? "");
        if (existing) intent = existing.status === "proposed" ? this.store.update(existing.id, { title, spec, folder: dir }) : existing;
        else intent = this.store.create({ kind: "intent", title, spec, status: "proposed", derived: true, folder: dir, parent: intentParent });
        const valid = new Set(syms.map((s) => s.key)); const used = new Set<string>();
        const room = Math.max(0, FAN_OUT_CAP - this.store.children(intent.id).length);
        const behaviors: any[] = (parsed.behaviors ?? []).slice(0, room).map((b: any) => ({ ...b, kind: "behavior", anchors: (b.anchors ?? []).filter((k: string) => valid.has(k) && !used.has(k) && (used.add(k), true)).map((k: string) => toAnchor(this.idx.db.symbol(k)!)) }));
        if ((parsed.behaviors ?? []).length > room) this.log(`derive ${dir}: dropped ${(parsed.behaviors ?? []).length - room} behaviors (fan-out cap)`, "warn");
        created.push(...this.materialize(behaviors, intent.id, true));
      }
      if (!existing) created.push(intent.id);
      intentByDir.set(dir, intent);
      for (const s of subs) if (s.parent !== intent.id && s.id !== intent.id) { try { this.store.update(s.id, { parent: intent.id }); } catch (e) { this.log(String(e), "warn"); } }
    }
    onProgress?.(null, work.length, work.length);
    void this.summarizeAll(false, (m) => this.log(m)).catch((e) => this.log(String(e), "warn"));
    return { created };
  }
  /** Re-ask the LLM for a behavior's title/spec/examples from its current anchors (anchors kept). Goes through putNode so spec changes stage the node. */
  async regenerateBehavior(id: string) {
    const n = this.store.get(id); if (!n || n.kind !== "behavior") throw new Error(`unknown behavior ${id}`);
    const anchors = n.anchors ?? []; if (!anchors.length) throw new Error(`${n.title} has no anchored symbols to regenerate from`);
    const sources = anchors.map((a) => ({ key: anchorKey(a), source: this.idx.symbolSource(anchorKey(a)) ?? "(symbol not found on disk)" }));
    const out = await this.runs.submit({ kind: "derive", node: id, prompt: behaviorPrompt(n, sources, n.parent ? this.store.get(n.parent) : null), extra: ["--tools", ""], schema: BEHAVIOR_SCHEMA, light: true }).done;
    const parsed = out.structured ?? extractJson(out.text);
    if (!parsed?.title) throw new Error(`regenerate ${id}: no output (${out.run.error ?? "empty"})`);
    const examples: Example[] = (parsed.examples ?? []).map((e: any, i: number) => ({ id: `ex_${newId("").slice(1)}`, name: e.name ?? `example ${i + 1}`, given: e.given, when: e.when, then: e.then, expect: { mode: "exit0" }, derived: true }));
    const updated = this.putNode(id, { title: String(parsed.title).slice(0, 120), spec: String(parsed.spec ?? ""), examples });
    void this.summarize(id).catch((e) => this.log(String(e), "warn"));
    return updated;
  }

  /** Compact repo overview for providers that cannot read the tree themselves. */
  repoSummary(maxLines = 300): string {
    const lines: string[] = [];
    for (const f of this.idx.db.allFiles()) {
      const syms = this.idx.db.symbolsInFile(f.path).filter((s) => s.exported || s.container === "").map((s) => `${s.container ? s.container + "." : ""}${s.name}`);
      lines.push(`${f.path}: ${syms.slice(0, 12).join(", ")}${syms.length > 12 ? ", …" : ""}`);
      if (lines.length >= maxLines) { lines.push("…"); break; }
    }
    return lines.join("\n");
  }

  // ---------- relations / summaries ----------
  relations(): Record<string, NodeRelations> {
    if (!this.relCache) this.relCache = { at: Date.now(), data: computeRelations(this.store, this.idx.db) };
    return this.relCache.data;
  }

  /** Gemini-written orientation summary with [[node_id]] links. */
  async summarize(id: string): Promise<LenzNode | null> {
    const n = this.store.get(id); if (!n || this.summarizing.has(id)) return n;
    this.summarizing.add(id);
    try {
      const rel = this.relations()[id] ?? { out: [], in: [] };
      const named = (r: { id: string; via: string[] }[]) => r.map((x) => ({ id: x.id, title: this.store.get(x.id)?.title ?? x.id, via: x.via })).filter((x) => this.store.get(x.id));
      const prompt = summaryPrompt(n, n.parent ? this.store.get(n.parent) : null, this.store.children(id), named(rel.out), named(rel.in));
      const r = await this.runs.submit({ kind: "compare", node: id, prompt, extra: ["--tools", ""], light: true }).done;
      const text = r.text.trim();
      if (!text) { this.log(`summary ${id}: ${r.run.error ?? "empty"}`, "warn"); return this.store.get(id); }
      const known = new Set(this.store.all().map((x) => x.id));
      const clean = text.replace(/\[\[(n_[a-z0-9]+)\]\]/g, (m, nid) => (known.has(nid) ? m : this.store.get(nid)?.title ?? "")); // drop hallucinated links
      return this.store.update(id, { summary: clean, summary_at: new Date().toISOString() });
    } finally { this.summarizing.delete(id); }
  }
  /** Summarize every node lacking a summary (or all with force), sequentially in the background. */
  async summarizeAll(force = false, onProgress?: (msg: string) => void) {
    const todo = this.store.all().filter((n) => force || !n.summary);
    // parents after children is not required (summaries are independent); go top-down for nicer UX
    const order = [...todo].sort((a, b) => this.store.ancestors(a.id).length - this.store.ancestors(b.id).length);
    let done = 0;
    for (const n of order) { await this.summarize(n.id); done++; onProgress?.(`summarized ${done}/${order.length}: ${n.title}`); }
    return { summarized: done };
  }

  status() {
    const nodes = this.store.all();
    return {
      runs: this.runs.list().filter((r) => r.status === "running" || r.status === "queued").length,
      locks: this.locks.list().length,
      drifted: nodes.filter((n) => n.status === "drifted").length,
      staged: this.staging(),
      orphans: this.orphans().orphan_count,
      nodes: nodes.length,
      deriving: this.deriving,
    };
  }
}

function docOf(idx: StructureIndex, s: SymbolRow): string {
  try {
    const lines = readFileSync(idx.abs(s.file), "utf8").split("\n");
    const above = lines.slice(Math.max(0, s.start_line - 4), s.start_line - 1).filter((l) => /^\s*(\/\/|\*|\/\*|#)/.test(l));
    return above.map((l) => l.replace(/^\s*(\/\/|\*|\/\*+|#)\s?/, "")).join(" ").trim();
  } catch { return ""; }
}

export function extractJson(text: string): any {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cands = [fence?.[1], text];
  for (const c of cands) {
    if (!c) continue;
    const i = c.search(/[{[]/); if (i < 0) continue;
    for (let end = c.length; end > i; end--) { const ch = c[end - 1]; if (ch !== "}" && ch !== "]") continue; try { return JSON.parse(c.slice(i, end)); } catch {} }
  }
  return null;
}

export function fanOutViolation(nodes: any[], existingAtRoot = 0): string | null {
  if (nodes.length + existingAtRoot > FAN_OUT_CAP) return `top level would have ${nodes.length + existingAtRoot} children (max ${FAN_OUT_CAP})`;
  for (const n of nodes) { const c = n.children ?? []; if (c.length > FAN_OUT_CAP) return `"${n.title}" has ${c.length} children (max ${FAN_OUT_CAP})`; const v = fanOutViolation(c); if (v) return v; }
  return null;
}

function renderTree(items: any[], store: NodeStore, depth = 0): string {
  return items.map((t) => `${"  ".repeat(depth)}- [${t.kind}] ${t.title} (${t.status}) — ${oneLine(store.get(t.id)?.spec ?? "", 100)}${t.children.length ? "\n" + renderTree(t.children, store, depth + 1) : ""}`).join("\n");
}
export { FanOutError };
