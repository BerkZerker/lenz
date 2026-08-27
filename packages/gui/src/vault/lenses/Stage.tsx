import { api } from "../../api";
import { useStore } from "../../store";
import { NodeCard } from "../../components/common";

export function StageLens() {
  const { nodes, status, selected, setSelected } = useStore();
  const st = status?.staged;
  const staged = (st?.staged ?? []).map((id) => nodes[id]).filter(Boolean);
  const blast = (st?.blast ?? []).map((id) => nodes[id]).filter(Boolean);
  return (
    <>
      <div className="section"><div className="section-h">staged ({staged.length}) — spec edits waiting to be dispatched</div>
        <div className="cards">{staged.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} extra={<button onClick={(e) => { e.stopPropagation(); api(`/nodes/${n.id}`, { staged: false }, "PUT"); }}>unstage</button>} />)}</div>
        {!staged.length && <div className="dim">edit a spec (e) to stage it</div>}
      </div>
      <div className="section"><div className="section-h">blast radius ({blast.length}) — will be flagged needs-reverify</div>
        <div className="dim" style={{ marginBottom: 6 }}>staged ∪ nodes depending on staged ∪ nodes anchored one hop away over refs</div>
        <div className="cards">{blast.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} />)}</div>
      </div>
      <div className="row"><button className="primary" disabled={!staged.length} onClick={() => api("/staging/confirm", {})}>confirm — dispatch {staged.length} in topological order</button>
        <button onClick={() => api("/staging/immediate", { on: !st?.immediate })}>immediate mode: {st?.immediate ? "on" : "off"}</button></div>
      <div className="hint">c confirms · i toggles immediate mode (confirm on every edit)</div>
    </>
  );
}
