import { anchorKey } from "@lenzgraph/structure";
import type { NodeStore } from "./nodes.ts";
import type { StructureDb } from "@lenzgraph/structure";

export interface Relation { id: string; via: string[] } // peer node id + up to a few "symbol → symbol" examples
export interface NodeRelations { out: Relation[]; in: Relation[] }

/**
 * Peer-level relations: aggregate symbol refs to nodes, then lift the other side to the ancestor that sits at
 * the same depth as `id` (so an intent's summary talks about sibling intents, a behavior's about sibling behaviors).
 * Relations inside the node's own subtree are dropped.
 */
export function computeRelations(store: NodeStore, db: StructureDb): Record<string, NodeRelations> {
  const owner = new Map<string, string>();
  for (const r of db.ownedSymbols()) owner.set(r.key, r.node_id);
  const depthOf = new Map<string, number>(); const chain = new Map<string, string[]>(); // id → [self, parent, ..., root]
  for (const n of store.all()) { const c = [n.id, ...store.ancestors(n.id).map((a) => a.id)]; chain.set(n.id, c); depthOf.set(n.id, c.length - 1); }
  const liftTo = (target: string, depth: number) => { const c = chain.get(target); if (!c) return null; const i = c.length - 1 - depth; return i >= 0 ? c[i] : null; };
  const symName = (k: string) => k.split("#").slice(2).filter(Boolean).slice(-1)[0] ?? k;
  const out: Record<string, NodeRelations> = {};
  const refs = db.allRefs();
  for (const n of store.all()) {
    const mine = new Set(store.anchorsOf(n.id).map(anchorKey));
    if (!mine.size) { out[n.id] = { out: [], in: [] }; continue; }
    const subtree = new Set([n.id, ...store.descendants(n.id).map((d) => d.id)]);
    const d = depthOf.get(n.id)!;
    const collect = (dir: "out" | "in") => {
      const acc = new Map<string, string[]>();
      for (const r of refs) {
        const me = dir === "out" ? r.src_key : r.dst_key, other = dir === "out" ? r.dst_key : r.src_key;
        if (!mine.has(me)) continue;
        const o = owner.get(other); if (!o || subtree.has(o)) continue;
        const peer = liftTo(o, d); if (!peer || subtree.has(peer)) continue;
        const a = acc.get(peer) ?? []; if (a.length < 4) a.push(`${symName(me)} → ${symName(other)}`); acc.set(peer, a);
      }
      return [...acc].map(([id, via]) => ({ id, via }));
    };
    out[n.id] = { out: collect("out"), in: collect("in") };
  }
  return out;
}
