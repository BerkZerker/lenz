import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

interface FlowNode { key: string; symbol: { name: string; kind: string; file: string; container: string; start_line: number }; provenance: string | null; children: FlowNode[]; cycle?: boolean; truncated?: boolean }

export function FlowLens() {
  const status = useStore((s) => s.status);
  const [entries, setEntries] = useState<{ key: string; source: string; symbol: any }[]>([]);
  const flowFrom = useStore((s) => s.flowFrom); const setFlowFrom = useStore((s) => s.setFlowFrom);
  const from = flowFrom; const setFrom = setFlowFrom;
  const [tree, setTree] = useState<FlowNode | null>(null);
  const [pin, setPin] = useState("");
  useEffect(() => { api("/flow").then((r) => setEntries(r.entries)); }, [status?.nodes]);
  useEffect(() => { if (from) api(`/flow?from=${encodeURIComponent(from)}`).then((r) => setTree(r.tree)); else setTree(null); }, [from, status?.orphans]);
  const owners = useStore((s) => s.nodes);
  const ownerOf = (key: string) => Object.values(owners).find((n) => (n.anchors ?? []).some((a) => `${a.file}#${a.container}#${a.kind}#${a.name}` === key));
  const render = (n: FlowNode, depth: number): React.ReactNode => (
    <div key={n.key + depth} className={`flow-node ${n.provenance ?? ""}`}>
      <div className="flow-label" onClick={() => setFrom(n.key)} title={n.key}>
        {n.symbol.container ? n.symbol.container + "." : ""}{n.symbol.name}<span className="dim"> {n.symbol.file}:{n.symbol.start_line}</span>
        {n.provenance && <span className="dim"> [{n.provenance}]</span>}{n.cycle && <span className="warn"> ↺</span>}{n.truncated && <span className="dim"> …</span>}
        {ownerOf(n.key) && <span className="tag" style={{ marginLeft: 6 }}>{ownerOf(n.key)!.title}</span>}
      </div>
      {n.children.map((c) => render(c, depth + 1))}
    </div>
  );
  return (
    <>
      <div className="section"><div className="section-h">logical execution flow — entry points ({entries.length})</div>
        <div className="dim" style={{ marginBottom: 4 }}>pick an entry point (or "flow →" on a node in the graph) to walk the call tree from there; each symbol shows the node that owns it.</div>
        <div className="row">{entries.map((e) => <button key={e.key} className={from === e.key ? "primary" : ""} onClick={() => setFrom(e.key)}>{e.symbol?.name}<span className="dim"> {e.symbol?.file}{e.source === "pinned" ? " ·pin" : ""}</span></button>)}</div>
        <div className="row"><input placeholder="pin a symbol key: file#container#kind#name" value={pin} onChange={(e) => setPin(e.target.value)} style={{ width: 420 }} /><button onClick={() => api("/flow/pin", { key: pin, pinned: true }).then((r) => { setEntries(r.entries); setPin(""); })}>pin</button></div>
      </div>
      <div className="section"><div className="section-h">call tree{from ? ` — from ${from.split("#").pop()}` : ""}</div>
        {tree ? render(tree, 0) : <div className="dim">pick an entry point. scip edges render normal; syntactic edges render dim italic.</div>}
      </div>
    </>
  );
}
