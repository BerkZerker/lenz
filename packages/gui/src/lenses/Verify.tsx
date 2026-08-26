import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { NodeCard, StatusTag } from "../components/common";
import type { LenzNode } from "../types";

export function VerifyLens() {
  const { nodes, selected, setSelected, runs } = useStore();
  const list = Object.values(nodes).filter((n) => n.status === "built" || n.status === "drifted" || (n.status === "verified" && n.needs_reverify)).sort((a, b) => a.status.localeCompare(b.status) || a.title.localeCompare(b.title));
  const cur = selected ? nodes[selected] : null;
  const showDetail = cur && list.includes(cur);
  return (
    <>
      <div className="section"><div className="section-h">needs judgment ({list.length})</div>
        <div className="cards">{list.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} extra={<Summary n={n} />} />)}</div>
        {!list.length && <div className="hint">nothing to verify. built and drifted nodes appear here.</div>}
      </div>
      {showDetail && <Detail n={cur} runId={cur.last_run} runs={runs} />}
      <div className="hint">a approve → verified · r reject with note → re-dispatch</div>
    </>
  );
}
function Summary({ n }: { n: LenzNode }) {
  const v = n.verification;
  return <span>
    {v?.examples && <span className={v.examples.fail ? "bad" : "ok"}>ex {v.examples.pass}/{v.examples.pass + v.examples.fail + v.examples.pending}</span>}
    {v?.machine && <span className={v.machine.ok ? "ok" : "bad"}> · machine {v.machine.ok ? "ok" : "fail"}</span>}
    {v?.reconstruction && <span className={v.reconstruction.verdict === "match" ? "ok" : "bad"}> · recon {v.reconstruction.verdict}</span>}
    {!v?.reconstruction && n.status === "built" && <span className="dim"> · recon pending</span>}
  </span>;
}

function Detail({ n, runId, runs }: { n: LenzNode; runId?: string; runs: any[] }) {
  const [tab, setTab] = useState<"examples" | "reconstruction" | "machine" | "changes" | "collateral">("examples");
  const nodes = useStore((s) => s.nodes);
  const v = n.verification;
  const run = runs.find((r) => r.id === runId);
  const collateral = Object.values(nodes).filter((o) => o.id !== n.id && o.status === "drifted" && run && o.drift && o.drift.at >= (run.started_at ?? ""));
  const byFile = new Map<string, NonNullable<LenzNode["proposed_anchors"]>>();
  for (const p of n.proposed_anchors ?? []) { const a = byFile.get(p.file) ?? []; a.push(p); byFile.set(p.file, a); }
  const behaviors = Object.values(nodes).filter((o) => o.kind === "behavior" && o.id !== n.id);
  return (
    <div className="section box">
      <div className="row"><b>{n.title}</b><StatusTag status={n.status} />{run && <span className="dim">{run.id} · {run.status}{run.exit != null ? ` · exit ${run.exit}` : ""}{run.duration ? ` · ${Math.round(run.duration)}s` : ""}</span>}</div>
      {n.status === "drifted" && <div className="bad">drift: {n.drift?.reasons.join("; ")} <button onClick={() => api(`/nodes/${n.id}/drift`, { action: "holds" })}>spec still holds</button> <button onClick={() => api(`/nodes/${n.id}/drift`, { action: "rebuild" })}>re-build</button></div>}
      <div className="tabs">{(["examples", "reconstruction", "machine", "changes", "collateral"] as const).map((t) => <div key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</div>)}</div>
      {tab === "examples" && (
        <>
          {(n.examples ?? []).map((e) => { const r = v?.examples?.results.find((x) => x.id === e.id); return (
            <div className="box" key={e.id}>
              <div className="row"><b>{e.name}</b> <span className={r?.pass === true ? "ok" : r?.pass === false ? "bad" : "warn"}>{r ? (r.pass === true ? "PASS" : r.pass === false ? "FAIL" : "PENDING") : "not run"}</span> <span className="dim">{r?.note}</span>
                {(e.expect?.mode === "manual" || r?.pass === null) && <><button onClick={() => api(`/nodes/${n.id}/examples/${e.id}/mark`, { pass: true })}>mark pass</button><button onClick={() => api(`/nodes/${n.id}/examples/${e.id}/mark`, { pass: false })}>mark fail</button></>}</div>
              <div className="two">
                <div><div className="dim">intended (then)</div><div><span className="dim">given</span> {e.given}</div><div><span className="dim">when</span> {e.when}</div><div><b>then</b> {e.then}</div><div className="dim" style={{ marginTop: 4 }}>run: {e.run ?? "—"}</div></div>
                <div><div className="dim">actual{r?.exit != null ? ` (exit ${r.exit})` : ""}</div><pre style={{ fontSize: 12, maxHeight: 240, overflow: "auto" }}>{r?.actual || <span className="dim">(no output)</span>}</pre></div>
              </div>
            </div>); })}
          {!(n.examples ?? []).length && <div className="dim">no examples on this node</div>}
        </>
      )}
      {tab === "reconstruction" && (
        <>
          <div className="row">verdict: {v?.reconstruction ? <span className={v.reconstruction.verdict === "match" ? "ok" : "bad"}>{v.reconstruction.verdict}</span> : <span className="dim">pending</span>}<button onClick={() => api(`/nodes/${n.id}/reconstruct`, {})}>re-run</button></div>
          {v?.reconstruction?.reasons?.length ? <ul>{v.reconstruction.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : null}
          <div className="two"><div><div className="dim">spec</div><pre>{n.spec}</pre></div><div><div className="dim">reconstruction (blind read of the anchored code)</div><pre>{n.reconstruction ?? "—"}</pre></div></div>
          <div className="hint">mismatch → reject: "code wrong" or "code illegible" both go back to the agent with your note</div>
        </>
      )}
      {tab === "machine" && (v?.machine ? <><div className={v.machine.ok ? "ok" : "bad"}>{v.machine.ok ? "ok" : `failed (exit ${v.machine.exit})`} <span className="dim">{n.machine?.run}</span></div><pre style={{ fontSize: 12 }}>{v.machine.tail}</pre></> : <div className="dim">{n.machine?.run ? "not run yet" : "the agent registered no machine check"}</div>)}
      {tab === "changes" && (
        <>
          {[...byFile].map(([file, list]) => <div key={file} className="box"><div className="dim">{file}</div>
            {list.map((p) => { const key = `${p.file}#${p.container}#${p.kind}#${p.name}`; const owned = (n.anchors ?? []).some((a) => `${a.file}#${a.container}#${a.kind}#${a.name}` === key); return (
              <div className="row" key={key}><span className={p.change === "added" ? "ok" : p.change === "removed" ? "bad" : "warn"}>{p.change}</span> <span className="dim">{p.kind}</span> {p.container ? p.container + "." : ""}{p.name}
                {p.change !== "removed" && <select value={owned ? n.id : p.owner ?? ""} onChange={(e) => api(`/nodes/${n.id}/anchors/assign`, { key, owner: e.target.value || null })}>
                  <option value={n.id}>this node</option><option value="">leave orphan</option>{behaviors.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select>}
                {p.owner && p.owner !== n.id && <span className="warn">also owned by {nodes[p.owner]?.title ?? p.owner}</span>}
              </div>); })}
          </div>)}
          {!byFile.size && <div className="dim">no symbol changes were captured during the run</div>}
        </>
      )}
      {tab === "collateral" && (collateral.length ? collateral.map((o) => <div className="box" key={o.id}><b>{o.title}</b> <span className="bad">drifted</span> — {o.drift?.reasons.join("; ")}</div>) : <div className="dim">no other nodes drifted during this run</div>)}
    </div>
  );
}
