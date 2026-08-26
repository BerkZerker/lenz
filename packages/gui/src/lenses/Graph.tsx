import { useState } from "react";
import { useStore } from "../store";
import { NodeCard } from "../components/common";
import { GraphView } from "./GraphView";

export function GraphLens() {
  const { nodes, focus, selected, setSelected, setFocus } = useStore();
  const [mode, setMode] = useState<"graph" | "cards">(() => { try { return (localStorage.getItem("lg.graphMode") as any) || "graph"; } catch { return "graph"; } });
  const toggle = (m: "graph" | "cards") => { setMode(m); try { localStorage.setItem("lg.graphMode", m); } catch {} };
  const switcher = <div className="row" style={{ marginBottom: 6 }}><span className="dim">view:</span><button className={mode === "graph" ? "primary" : ""} onClick={() => toggle("graph")}>graph</button><button className={mode === "cards" ? "primary" : ""} onClick={() => toggle("cards")}>cards</button></div>;
  if (mode === "graph") return <div style={{ height: "calc(100vh - 62px)", display: "flex", flexDirection: "column", margin: "-8px -10px" }}><GraphView /><div style={{ position: "absolute", right: 10, bottom: 34, zIndex: 3 }} className="dim"><span className="link" onClick={() => toggle("cards")}>[cards view]</span></div></div>;
  const children = Object.values(nodes).filter((n) => n.parent === focus).sort((a, b) => a.title.localeCompare(b.title));
  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: "app" }];
  let p = focus ? nodes[focus] : null; const chain: typeof crumbs = [];
  while (p) { chain.unshift({ id: p.id, title: p.title }); p = p.parent ? nodes[p.parent] : null; }
  crumbs.push(...chain);
  return (
    <>
      {switcher}
      <div className="breadcrumb">{crumbs.map((c, i) => <span key={c.id ?? "root"} className={i === crumbs.length - 1 ? "here" : ""} onClick={() => { setFocus(c.id); setSelected(null); }}>{c.title}{i < crumbs.length - 1 ? " ▸ " : ""}</span>)}</div>
      {focus && nodes[focus] && <div className="dim" style={{ marginBottom: 10, whiteSpace: "pre-wrap" }}>{nodes[focus].spec}</div>}
      <div className="cards">
        {children.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => { setSelected(n.id); }} />)}
      </div>
      {!children.length && <div className="hint">{focus ? "leaf node — see inspector. esc to go up." : "empty graph. press 7 to propose, or run `lenzgraph derive`."}</div>}
      <div className="hint">enter drills into an intent · a approve · e edit · d dispatch · n new child · x delete</div>
    </>
  );
}
