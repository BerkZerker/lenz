import { useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import { fmtTime, short } from "../../components/common";

export function RunsLens() {
  const { runs, locks, lockLog, runEvents, nodes, logs } = useStore();
  const [sel, setSel] = useState<string | null>(null);
  const cur = sel ?? runs.find((r) => r.status === "running")?.id ?? runs[0]?.id ?? null;
  const events = runEvents.filter((e) => e.run === cur);
  return (
    <>
      <div className="section"><div className="section-h">runs ({runs.filter((r) => r.status === "running").length} running)</div>
        <table><thead><tr><th>id</th><th>kind</th><th>node</th><th>status</th><th>started</th><th>dur</th><th>cost</th><th></th></tr></thead><tbody>
          {runs.slice(0, 40).map((r) => <tr key={r.id} className={r.id === cur ? "accent" : ""} onClick={() => setSel(r.id)} style={{ cursor: "pointer" }}>
            <td>{r.id}</td><td>{r.kind}</td><td>{r.node ? short(nodes[r.node]?.title ?? r.node, 30) : "—"}</td><td className={r.status === "running" ? "warn" : r.status === "done" ? "ok" : r.status === "queued" ? "dim" : "bad"}>{r.status}</td>
            <td>{fmtTime(r.started_at)}</td><td>{r.duration ? `${Math.round(r.duration)}s` : ""}</td><td>{r.cost_usd ? `$${r.cost_usd.toFixed(2)}` : ""}</td>
            <td>{(r.status === "running" || r.status === "queued") && <button onClick={(e) => { e.stopPropagation(); api(`/runs/${r.id}/kill`, {}); }}>kill</button>}</td></tr>)}
        </tbody></table>
        {!runs.length && <div className="dim">no runs yet</div>}
      </div>
      <div className="two">
        <div className="section"><div className="section-h">events — {cur ?? "none"}</div>
          <div className="events" style={{ maxHeight: 420, overflow: "auto" }}>
            {events.slice(-300).map((e, i) => <div key={i}><span className="dim">{fmtTime(e.at)} </span>{renderEvent(e.event)}</div>)}
            {cur && !events.length && <div className="dim">{runs.find((r) => r.id === cur)?.error ?? "no events captured in this session"}</div>}
          </div>
        </div>
        <div>
          <div className="section"><div className="section-h">locks ({locks.length})</div>
            <table><thead><tr><th>file</th><th>run</th><th>last write</th></tr></thead><tbody>
              {locks.map((l) => <tr key={l.file}><td>{l.file}</td><td>{l.run}</td><td>{Math.round((Date.now() - l.last_write_at) / 1000)}s ago</td></tr>)}
            </tbody></table>
          </div>
          <div className="section"><div className="section-h">lock log</div>
            <div className="events" style={{ maxHeight: 180, overflow: "auto" }}>{lockLog.slice(-60).reverse().map((e, i) => <div key={i}><span className="dim">{fmtTime(e.at)} </span><span className={e.kind === "deny" ? "bad" : e.kind === "transfer" ? "warn" : ""}>{e.kind}</span> {e.file} <span className="dim">{e.run}{e.from ? ` ← ${e.from}` : ""}{e.reason ? ` — ${e.reason}` : ""}</span></div>)}</div>
          </div>
          <div className="section"><div className="section-h">daemon log</div>
            <div className="events" style={{ maxHeight: 160, overflow: "auto" }}>{logs.slice(-40).reverse().map((l, i) => <div key={i}><span className="dim">{fmtTime(l.at)} </span><span className={l.level === "error" ? "bad" : l.level === "warn" ? "warn" : ""}>{l.msg}</span></div>)}</div>
          </div>
        </div>
      </div>
    </>
  );
}
function renderEvent(e: any) {
  if (!e) return null;
  switch (e.type) {
    case "init": return <span className="dim">session {e.session_id} · {e.model}</span>;
    case "tool": return <span><span className="accent">{e.name}</span> <span className="dim">{short(JSON.stringify(e.input ?? {}), 160)}</span></span>;
    case "tool_result": return <span className={e.is_error ? "bad" : "dim"}>↳ {short((e.text ?? "").replace(/\s+/g, " "), 160)}</span>;
    case "text": return <span>{short(e.text, 400)}</span>;
    case "result": return <span className="ok">result · {e.subtype} · {e.turns} turns · ${(e.cost ?? 0).toFixed(3)}</span>;
    default: return <span className="dim">{short(JSON.stringify(e), 160)}</span>;
  }
}
