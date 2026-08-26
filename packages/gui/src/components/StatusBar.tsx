import { api } from "../api";
import { useStore } from "../store";

export function StatusBar() {
  const { status, lens, setLens, connected, toast } = useStore();
  const s = status;
  const staged = s?.staged.staged.length ?? 0, blast = s?.staged.blast.length ?? 0;
  return (
    <div className="statusbar">
      <span><b>{s?.runs ?? 0}</b> runs</span>
      <span><b>{s?.locks ?? 0}</b> locks</span>
      <span className={s?.drifted ? "bad" : ""}><b>{s?.drifted ?? 0}</b> drifted</span>
      <span><b>{s?.orphans ?? 0}</b> orphans</span>
      <span className={`link ${lens === "stage" ? "active" : ""}`} onClick={() => setLens("stage")}>staged: <b>{staged}</b> (blast {blast})</span>
      <span className={`link ${lens === "propose" ? "active" : ""}`} onClick={() => setLens("propose")}>[propose]</span>
      <span className="link" onClick={() => api("/staging/immediate", { on: !s?.staged.immediate })}>[immediate: {s?.staged.immediate ? "on" : "off"}]</span>
      {s?.deriving && <span className="derive-progress" title={`deriving ${s.deriving.scope}`}><span className="accent">deriving</span> {s.deriving.done}/{s.deriving.total || "?"} <span className="dim">{s.deriving.current}</span><span className="bar"><span style={{ width: `${s.deriving.total ? Math.round((100 * s.deriving.done) / s.deriving.total) : 0}%` }} /></span></span>}
      <span style={{ marginLeft: "auto" }} className={connected ? "dim" : "bad"}>{connected ? "● live" : "○ disconnected"}</span>
      {toast && <span className="accent">{toast}</span>}
      <span className="dim">? help</span>
    </div>
  );
}
