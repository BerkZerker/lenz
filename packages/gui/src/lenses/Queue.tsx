import { api } from "../api";
import { useStore } from "../store";
import { NodeCard } from "../components/common";

export function QueueLens() {
  const { nodes, selected, setSelected, runs } = useStore();
  // topological by deps among specified nodes
  const all = Object.values(nodes);
  const ready = all.filter((n) => n.kind === "behavior" && (n.status === "specified" || n.status === "rejected"));
  const order: typeof ready = []; const seen = new Set<string>();
  const visit = (n: (typeof ready)[number]) => { if (seen.has(n.id)) return; seen.add(n.id); for (const d of n.deps) { const dn = nodes[d]; if (dn && ready.includes(dn)) visit(dn); } order.push(n); };
  ready.sort((a, b) => a.title.localeCompare(b.title)).forEach(visit);
  const running = all.filter((n) => n.status === "building");
  const blocked = (n: (typeof ready)[number]) => n.deps.filter((d) => nodes[d] && !["verified", "built"].includes(nodes[d].status));
  return (
    <>
      {running.length > 0 && <div className="section"><div className="section-h">building ({running.length})</div><div className="cards">{running.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} extra={<span className="dim">{runs.find((r) => r.id === n.last_run)?.id}</span>} />)}</div></div>}
      <div className="section"><div className="section-h">queue — topological by deps ({order.length})</div>
        <div className="cards">{order.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} extra={
          <>{blocked(n).length > 0 && <span className="warn">waits on {blocked(n).map((d) => nodes[d]?.title).join(", ")}</span>}
            <button className="primary" onClick={(e) => { e.stopPropagation(); api(`/nodes/${n.id}/dispatch`, {}).catch((err) => useStore.getState().notify(err.message)); }}>dispatch</button></>} />)}</div>
        {!order.length && <div className="hint">nothing specified. approve proposed nodes in the graph lens (a).</div>}
      </div>
      <div className="hint">d dispatches the selected node · runs are capped by max_concurrent_runs</div>
    </>
  );
}
