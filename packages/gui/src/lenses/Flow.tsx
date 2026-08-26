import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { areaColor } from "../colors";

interface FlowNode { key: string; symbol: { name: string; kind: string; file: string; container: string; start_line: number }; provenance: string | null; children: FlowNode[]; cycle?: boolean; truncated?: boolean }

const AUTO_OPEN_DEPTH = 2;

/** logical execution flow: a static call tree from an entry point, each symbol tagged with the node that owns it */
export function FlowLens() {
  const status = useStore((s) => s.status);
  const nodes = useStore((s) => s.nodes);
  const from = useStore((s) => s.flowFrom); const setFrom = useStore((s) => s.setFlowFrom);
  const setFocus = useStore((s) => s.setFocus); const setSelected = useStore((s) => s.setSelected); const setLens = useStore((s) => s.setLens);
  const [entries, setEntries] = useState<{ key: string; source: string; symbol: any }[]>([]);
  const [tree, setTree] = useState<FlowNode | null>(null);
  const [pin, setPin] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  useEffect(() => { api("/flow").then((r) => setEntries(r.entries.filter((e: any) => e.symbol))); }, [status?.nodes]);
  useEffect(() => { if (from) api(`/flow?from=${encodeURIComponent(from)}`).then((r) => { setTree(r.tree); setClosed(new Set()); setAllOpen(false); }); else setTree(null); }, [from, status?.orphans]);
  const ownerOf = useMemo(() => { const m = new Map<string, string>(); for (const n of Object.values(nodes)) for (const a of n.anchors ?? []) m.set(`${a.file}#${a.container}#${a.kind}#${a.name}`, n.id); return m; }, [nodes]);
  const count = useMemo(() => { const c = (n: FlowNode): number => 1 + n.children.reduce((a, x) => a + c(x), 0); return tree ? c(tree) : 0; }, [tree]);

  const isOpen = (path: string, depth: number) => (closed.has(path) ? false : allOpen || depth < AUTO_OPEN_DEPTH ? true : closed.has("!" + path));
  const toggle = (path: string, depth: number) => setClosed((s) => { const n = new Set(s); const open = isOpen(path, depth); if (open) { n.add(path); n.delete("!" + path); } else { n.delete(path); n.add("!" + path); } return n; });
  const goOwner = (id: string) => { const x = nodes[id]; if (!x) return; setFocus(x.kind === "intent" ? x.id : x.parent); setSelected(x.id); setLens("graph"); };

  const render = (n: FlowNode, depth: number, path: string): React.ReactNode => {
    const owner = ownerOf.get(n.key); const o = owner ? nodes[owner] : null;
    const has = n.children.length > 0; const open = has && isOpen(path, depth);
    return (
      <div key={path} className={`flow-node ${n.provenance ?? ""}`}>
        <div className="flow-label" title={n.key}>
          <span className={`chev ${has ? "" : "leaf"}`} onClick={() => has && toggle(path, depth)}>{open ? "▾" : "▸"}</span>
          <span onClick={() => setFrom(n.key)}>{n.symbol.container ? n.symbol.container + "." : ""}{n.symbol.name}</span><span className="dim"> {n.symbol.file}:{n.symbol.start_line}</span>
          {n.provenance && <span className="dim"> [{n.provenance}]</span>}{n.cycle && <span className="warn" title="cycle"> ↺</span>}{n.truncated && <span className="dim"> …</span>}
          {has && !open && <span className="dim"> ({n.children.length})</span>}
          {o && <span className="tag" style={{ marginLeft: 6, color: areaColor(nodes, o.id), borderColor: areaColor(nodes, o.id), cursor: "pointer" }} onClick={() => goOwner(o.id)} title="owning node — click to open in the graph">{o.title}</span>}
        </div>
        {open && n.children.map((c, i) => render(c, depth + 1, path + "/" + i))}
      </div>
    );
  };
  return (
    <>
      <div className="section"><div className="section-h">logical execution flow — entry points ({entries.length})</div>
        <div className="dim" style={{ marginBottom: 4 }}>pick an entry point (or "flow →" on a node in the graph) to walk the static call tree from there; each symbol is tagged with the node that owns it. in the graph, the <b>flow</b> toggle shows the same relations as directed arrows between the loaded nodes.</div>
        <div className="row">{entries.map((e) => <button key={e.key} className={from === e.key ? "primary" : ""} onClick={() => setFrom(e.key)}>{e.symbol?.container ? e.symbol.container + "." : ""}{e.symbol?.name}<span className="dim"> {e.symbol?.file}{e.source === "pinned" ? " ·pin" : ""}</span></button>)}</div>
        <div className="row"><input placeholder="pin a symbol key: file#container#kind#name" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 420 }} /><button onClick={() => api("/flow/pin", { key: pin, pinned: true }).then((r) => { setEntries(r.entries.filter((e: any) => e.symbol)); setPin(""); })}>pin</button></div>
      </div>
      <div className="section"><div className="section-h">call tree{from ? ` — from ${from.split("#").pop()} · ${count} calls` : ""}
        {tree && <span className="tree-tools" style={{ marginLeft: 12, display: "inline-flex" }}><button onClick={() => { setAllOpen(true); setClosed(new Set()); }} title="expand all">⊞</button><button onClick={() => { setAllOpen(false); setClosed(new Set()); }} title="collapse to depth 2">⊟</button></span>}</div>
        {tree ? render(tree, 0, "0") : <div className="dim">pick an entry point. scip edges render normal; syntactic edges render dim italic.</div>}
      </div>
    </>
  );
}
