import type { StructureDb } from "./db.ts";
import type { Provenance, SymbolRow } from "./types.ts";

export interface FlowNode { key: string; symbol: SymbolRow; provenance: Provenance | null; children: FlowNode[]; cycle?: boolean; truncated?: boolean }

/** Static call tree from an entry point, children ordered by source position of the call. */
export function flowFrom(db: StructureDb, key: string, maxDepth = 8, maxNodes = 400): FlowNode | null {
  const root = db.symbol(key);
  if (!root) return null;
  let count = 0;
  const walk = (s: SymbolRow, prov: Provenance | null, path: Set<string>, depth: number): FlowNode => {
    count++;
    const node: FlowNode = { key: s.key, symbol: s, provenance: prov, children: [] };
    if (path.has(s.key)) { node.cycle = true; return node; }
    if (depth >= maxDepth || count > maxNodes) { node.truncated = true; return node; }
    const next = new Set(path); next.add(s.key);
    const refs = db.refsFrom(s.key).filter((r) => r.kind === "calls" || r.kind === "extends");
    refs.sort((a, b) => a.line - b.line);
    for (const r of refs) {
      const t = db.symbol(r.dst_key);
      if (t) node.children.push(walk(t, r.provenance, next, depth + 1));
    }
    return node;
  };
  return walk(root, null, new Set(), 0);
}
