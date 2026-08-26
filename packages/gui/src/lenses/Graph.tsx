import { useStore } from "../store";
import { NodeCard } from "../components/common";

export function GraphLens() {
  const { nodes, focus, selected, setSelected, setFocus } = useStore();
  const children = Object.values(nodes).filter((n) => n.parent === focus).sort((a, b) => a.title.localeCompare(b.title));
  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: "app" }];
  let p = focus ? nodes[focus] : null; const chain: typeof crumbs = [];
  while (p) { chain.unshift({ id: p.id, title: p.title }); p = p.parent ? nodes[p.parent] : null; }
  crumbs.push(...chain);
  return (
    <>
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
