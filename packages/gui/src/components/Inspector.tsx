import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { StatusTag } from "./common";
import { Summary } from "./Summary";
import { areaColor } from "../colors";
import { deriveNode } from "../derive";

export function Inspector() {
  const { selected, focus, nodes, runs } = useStore();
  const id = selected ?? focus;
  const n = id ? nodes[id] : null;
  const [tab, setTab] = useState<"spec" | "examples" | "anchors" | "verify" | "reconstruction">("spec");
  const [src, setSrc] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => { setSrc(null); }, [id]);
  if (!n) return <div className="pane"><div className="pane-header">inspector</div><div className="pane-body dim">select a node</div></div>;
  const run = runs.find((r) => r.id === n.last_run);
  const v = n.verification;
  return (
    <div className="pane">
      <div className="pane-header"><span>inspector</span><span>{n.id}</span></div>
      <div className="pane-body">
        <div className="row"><b style={{ color: areaColor(nodes, n.id) }}>{n.title}</b><StatusTag status={n.status} />{n.staged && <span className="tag accent">staged</span>}{n.needs_reverify && <span className="tag warn">needs-reverify</span>}</div>
        <div className="dim">{n.kind}{n.parent ? ` · under ${nodes[n.parent]?.title ?? n.parent}` : " · root"}{n.deps.length ? ` · deps: ${n.deps.map((d) => nodes[d]?.title ?? d).join(", ")}` : ""}</div>
        {n.status === "drifted" && <div className="box bad">drift: {n.drift?.reasons.join("; ")}<div className="row"><button onClick={() => api(`/nodes/${n.id}/drift`, { action: "holds" })}>spec still holds</button><button onClick={() => api(`/nodes/${n.id}/drift`, { action: "rebuild" })}>re-build</button></div></div>}
        {v?.rejection_note && n.status !== "verified" && <div className="box"><span className="dim">rejection note:</span> {v.rejection_note}</div>}
        <div className="tabs" style={{ marginTop: 8 }}>
          {(["spec", "examples", "anchors", "verify", "reconstruction"] as const).map((t) => <div key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</div>)}
        </div>
        {tab === "spec" && <>
          {n.summary && <div className="box" style={{ lineHeight: 1.5 }}><div className="dim" style={{ marginBottom: 4 }}>summary</div><Summary text={n.summary} /></div>}
          <pre>{n.spec || <span className="dim">(no spec — press e to edit)</span>}</pre>
          <div className="row"><button onClick={() => api(`/nodes/${n.id}/summarize`, {})}>{n.summary ? "re-summarize" : "summarize"}</button>{(n.kind === "intent" ? n.derived : (n.anchors ?? []).length > 0) && <button onClick={() => deriveNode(n)} title={n.kind === "intent" ? "re-derive this folder's subtree from code" : "rewrite spec + examples from the anchored code"}>regenerate</button>}</div>
        </>}
        {tab === "examples" && (n.examples?.length ? n.examples.map((e) => (
          <div className="box" key={e.id}><div><b>{e.name}</b> <span className="dim">{e.id}{e.derived ? " · derived" : ""}</span></div>
            <div><span className="dim">given</span> {e.given}</div><div><span className="dim">when </span> {e.when}</div><div><span className="dim">then </span> {e.then}</div>
            <div className="dim">run: {e.run ?? "(not yet written)"} · expect: {e.expect?.mode ?? "exit0"}</div></div>
        )) : <div className="dim">{n.kind === "intent" ? "intent nodes have no examples" : "no examples"}</div>)}
        {tab === "anchors" && (
          <>
            {(n.kind === "behavior" ? n.anchors ?? [] : []).map((a) => { const key = `${a.file}#${a.container}#${a.kind}#${a.name}`; return (
              <div key={key} className="box" style={{ cursor: "pointer" }} onClick={async () => { if (src?.key === key) return setSrc(null); const r = await api(`/symbols/${encodeURIComponent(key)}/source`); setSrc({ key, text: r.source }); }}>
                <span className="dim">{a.kind}</span> {a.container ? a.container + "." : ""}{a.name} <span className="dim">{a.file}</span>
                {src?.key === key && <pre style={{ marginTop: 6, fontSize: 12 }}>{src.text ?? "(symbol not found on disk)"}</pre>}
              </div>); })}
            {n.kind === "intent" && <div className="dim">intent: symbols are the union of descendants' anchors</div>}
            {n.kind === "behavior" && !(n.anchors ?? []).length && <div className="dim">no anchored symbols yet</div>}
          </>
        )}
        {tab === "verify" && (
          <>
            {run && <div className="box"><span className="dim">last run</span> {run.id} · {run.status} · {run.duration ? `${Math.round(run.duration)}s` : ""} {run.cost_usd ? `· $${run.cost_usd.toFixed(3)}` : ""}{run.error && <div className="bad">{run.error}</div>}</div>}
            <div className="box">examples: {v?.examples ? <span><span className="ok">{v.examples.pass} pass</span> · <span className={v.examples.fail ? "bad" : ""}>{v.examples.fail} fail</span> · {v.examples.pending} pending</span> : <span className="dim">not run</span>}</div>
            <div className="box">machine: {v?.machine ? <span className={v.machine.ok ? "ok" : "bad"}>{v.machine.ok ? "ok" : `failed (exit ${v.machine.exit})`}</span> : <span className="dim">{n.machine?.run ? "not run" : "no machine check"}</span>}</div>
            <div className="box">reconstruction: {v?.reconstruction ? <span className={v.reconstruction.verdict === "match" ? "ok" : "bad"}>{v.reconstruction.verdict}</span> : <span className="dim">pending</span>}</div>
            {v?.approved_by && <div className="dim">approved by {v.approved_by} at {v.approved_at}</div>}
            <div className="row"><button onClick={() => api(`/nodes/${n.id}/verify`, {})}>re-run examples</button><button onClick={() => api(`/nodes/${n.id}/reconstruct`, {})}>re-reconstruct</button></div>
          </>
        )}
        {tab === "reconstruction" && <pre>{n.reconstruction ?? <span className="dim">no reconstruction yet — produced after a build</span>}</pre>}
      </div>
    </div>
  );
}
