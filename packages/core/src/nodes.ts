import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import YAML from "yaml";
import { anchorKey, type StructureDb } from "@lenz/structure";
import type { LenzNode, NodeStatus } from "./types.ts";
import type { EventBus } from "./events.ts";

export const FAN_OUT_CAP = 9;

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "node";
}
export function newId(prefix = "n") { return `${prefix}_${Math.random().toString(16).slice(2, 8)}`; }

export class FanOutError extends Error { constructor(parent: string | null, n: number) { super(`fan-out cap: ${parent ?? "root"} would have ${n} children (max ${FAN_OUT_CAP}); add a grouping node`); } }

/**
 * YAML-backed store for L0/L1 nodes. Path = slug path under the parent; id is stable.
 * Every save mirrors anchors into structure.db and publishes node.updated.
 */
export class NodeStore {
  nodes = new Map<string, LenzNode>();
  paths = new Map<string, string>(); // id → yaml path (relative to nodesDir)
  constructor(public nodesDir: string, private db: StructureDb, private bus: EventBus) {
    mkdirSync(nodesDir, { recursive: true });
  }

  load() {
    this.nodes.clear(); this.paths.clear();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith(".yaml") || e.endsWith(".yml")) {
          try {
            const n = YAML.parse(readFileSync(p, "utf8")) as LenzNode;
            if (!n?.id) continue;
            n.deps ??= []; n.parent ??= null;
            this.nodes.set(n.id, n);
            this.paths.set(n.id, relative(this.nodesDir, p));
          } catch (err) { this.bus.publish("log", { level: "warn", msg: `bad node yaml ${p}: ${err}` }); }
        }
      }
    };
    walk(this.nodesDir);
    for (const n of this.nodes.values()) this.mirror(n);
  }

  get(id: string) { return this.nodes.get(id) ?? null; }
  all() { return [...this.nodes.values()]; }
  children(parent: string | null) { return this.all().filter((n) => n.parent === parent).sort((a, b) => a.title.localeCompare(b.title)); }
  descendants(id: string): LenzNode[] {
    const out: LenzNode[] = [];
    const walk = (p: string) => { for (const c of this.children(p)) { out.push(c); walk(c.id); } };
    walk(id); return out;
  }
  ancestors(id: string): LenzNode[] {
    const out: LenzNode[] = []; let n = this.get(id);
    while (n?.parent) { n = this.get(n.parent); if (n) out.push(n); }
    return out;
  }
  /** intent node's symbols = union of its descendants' anchors */
  anchorsOf(id: string) {
    const n = this.get(id); if (!n) return [];
    if (n.kind === "behavior") return n.anchors ?? [];
    return this.descendants(id).flatMap((d) => d.anchors ?? []);
  }

  private pathFor(n: LenzNode): string {
    const segs: string[] = [];
    let p = n.parent ? this.get(n.parent) : null;
    while (p) { segs.unshift(slugify(p.title)); p = p.parent ? this.get(p.parent) : null; }
    let base = slugify(n.title);
    const dir = segs.join("/");
    // sibling slug collision → disambiguate with the id
    for (const [id, p] of this.paths) if (id !== n.id && p === (dir ? dir + "/" : "") + base + ".yaml") { base = `${base}-${n.id.replace(/^n_/, "")}`; break; }
    return [...segs, base + ".yaml"].join("/");
  }

  assertFanOut(parent: string | null, excludeId?: string) {
    const n = this.children(parent).filter((c) => c.id !== excludeId).length + 1;
    if (n > FAN_OUT_CAP) throw new FanOutError(parent, n);
  }

  create(partial: Partial<LenzNode> & { title: string; kind: LenzNode["kind"] }): LenzNode {
    if (partial.parent && !this.get(partial.parent)) throw new Error(`unknown parent ${partial.parent}`);
    this.assertFanOut(partial.parent ?? null);
    const n: LenzNode = { ...partial, id: partial.id ?? newId(), kind: partial.kind, title: partial.title, parent: partial.parent ?? null, deps: partial.deps ?? [], status: partial.status ?? "proposed", spec: partial.spec ?? "" } as LenzNode;
    if (n.kind === "behavior") n.examples ??= [];
    this.nodes.set(n.id, n);
    this.save(n);
    return n;
  }

  save(n: LenzNode, opts: { silent?: boolean } = {}) {
    this.nodes.set(n.id, n);
    const target = this.pathFor(n);
    const prev = this.paths.get(n.id);
    const abs = join(this.nodesDir, target);
    mkdirSync(dirname(abs), { recursive: true });
    if (prev && prev !== target && existsSync(join(this.nodesDir, prev))) {
      renameSync(join(this.nodesDir, prev), abs);
      // children directories move with their parent's slug
      const prevDir = join(this.nodesDir, prev.replace(/\.ya?ml$/, ""));
      const newDir = abs.replace(/\.ya?ml$/, "");
      if (existsSync(prevDir)) renameSync(prevDir, newDir);
      for (const [id, p] of this.paths) if (p.startsWith(prev.replace(/\.ya?ml$/, "") + "/")) this.paths.set(id, p.replace(prev.replace(/\.ya?ml$/, ""), target.replace(/\.ya?ml$/, "")));
    }
    this.paths.set(n.id, target);
    const clean = JSON.parse(JSON.stringify(n)); // drop undefined
    writeFileSync(abs, YAML.stringify(clean, { lineWidth: 100 }));
    this.mirror(n);
    if (!opts.silent) this.bus.publish("node.updated", { id: n.id, node: n });
  }

  mirror(n: LenzNode) {
    if (n.kind === "behavior") this.db.setAnchors(n.id, (n.anchors ?? []).map(anchorKey));
    else this.db.deleteAnchors(n.id);
  }

  update(id: string, patch: Partial<LenzNode>): LenzNode {
    const n = this.get(id); if (!n) throw new Error(`unknown node ${id}`);
    if (patch.parent !== undefined && patch.parent !== n.parent) {
      if (patch.parent && (patch.parent === id || this.descendants(id).some((d) => d.id === patch.parent))) throw new Error("cannot reparent under own descendant");
      this.assertFanOut(patch.parent, id);
    }
    Object.assign(n, patch);
    this.save(n);
    return n;
  }

  setStatus(id: string, status: NodeStatus, extra: Partial<LenzNode> = {}) { return this.update(id, { status, ...extra }); }

  delete(id: string, recursive = true) {
    const n = this.get(id); if (!n) return;
    if (recursive) for (const c of this.children(id)) this.delete(c.id, true);
    else for (const c of this.children(id)) this.update(c.id, { parent: n.parent });
    const p = this.paths.get(id);
    if (p) { const abs = join(this.nodesDir, p); if (existsSync(abs)) unlinkSync(abs); const dir = abs.replace(/\.ya?ml$/, ""); if (existsSync(dir)) try { rmSync(dir, { recursive: true }); } catch {} }
    this.nodes.delete(id); this.paths.delete(id);
    this.db.deleteAnchors(id);
    for (const o of this.all()) if (o.deps.includes(id)) this.update(o.id, { deps: o.deps.filter((d) => d !== id) });
    this.bus.publish("node.deleted", { id });
  }

  /** Topological order by deps (stable on title); cycles are broken arbitrarily. */
  topo(ids?: string[]): LenzNode[] {
    const set = new Set(ids ?? this.all().map((n) => n.id));
    const out: LenzNode[] = []; const seen = new Set<string>(); const stack = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id) || !set.has(id)) return;
      if (stack.has(id)) return;
      stack.add(id);
      const n = this.get(id)!;
      for (const d of n.deps) visit(d);
      stack.delete(id); seen.add(id); out.push(n);
    };
    for (const n of this.all().sort((a, b) => a.title.localeCompare(b.title))) visit(n.id);
    return out;
  }

  tree(): TreeItem[] {
    const build = (parent: string | null): TreeItem[] => this.children(parent).map((n) => ({ id: n.id, kind: n.kind, title: n.title, status: n.status, staged: !!n.staged, needs_reverify: !!n.needs_reverify, children: build(n.id) }));
    return build(null);
  }
}
export interface TreeItem { id: string; kind: string; title: string; status: NodeStatus; staged: boolean; needs_reverify: boolean; children: TreeItem[] }
