import { api } from "../api";
import { useStore } from "../store";
import { deriveGraph } from "../derive";

export function StatusBar() {
  const { status, connected, toast, nodes } = useStore();
  const s = status;
  const staged = s?.staged.staged.length ?? 0, blast = s?.staged.blast.length ?? 0;
  const deriving = s?.deriving ?? null;
  const generated = Object.values(nodes).some((n) => n.derived);
  const pct = deriving?.total ? Math.round((100 * deriving.done) / deriving.total) : 0;

  return (
    <div className="statusbar">
      {/* always in the same place, and the same control reports its own progress while it runs */}
      <button className={`derive-btn ${generated || deriving ? "" : "primary"}`} disabled={!!deriving} onClick={deriveGraph}
        title={generated ? "re-derive the graph from code — asks which derived nodes to replace (g)" : "derive intent and behavior nodes from the code (g)"}>
        {deriving ? `generating ${deriving.done}/${deriving.total || "?"}` : generated ? "regenerate graph" : "generate graph"}
      </button>
      {deriving && (
        <span className="derive-progress" title={`deriving ${deriving.scope}`}>
          <span className="bar"><span style={{ width: `${pct}%` }} /></span>
          <span className="dim current">{deriving.current || deriving.scope}</span>
        </span>
      )}
      <span><b>{s?.runs ?? 0}</b> runs</span>
      <span><b>{s?.locks ?? 0}</b> locks</span>
      <span className={s?.drifted ? "bad" : ""}><b>{s?.drifted ?? 0}</b> drifted</span>
      <span><b>{s?.orphans ?? 0}</b> orphans</span>
      <span>staged: <b>{staged}</b> (blast {blast})</span>
      <span className="link" onClick={() => api("/staging/immediate", { on: !s?.staged.immediate })}>[immediate: {s?.staged.immediate ? "on" : "off"}]</span>
      <span style={{ marginLeft: "auto" }} className={connected ? "dim" : "bad"}>{connected ? "● live" : "○ disconnected"}</span>
      {toast && <span className="accent">{toast}</span>}
      <span className="dim">? help</span>
    </div>
  );
}
