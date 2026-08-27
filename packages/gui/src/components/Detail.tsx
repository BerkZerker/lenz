import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { StatusTag } from "./common";
import { Summary } from "./Summary";
import { areaColor } from "../colors";
import { deriveNode } from "../derive";

type Tab = "spec" | "flow" | "examples" | "anchors" | "verify" | "reconstruction";
const TABS: Tab[] = ["spec", "flow", "examples", "anchors", "verify", "reconstruction"];

interface FlowStep { id: string; title: string; kind: string; via: string[]; children: FlowStep[]; cycle?: boolean; repeat?: boolean; truncated?: boolean }
interface EntryPoint { key: string; source: string; file: string; name: string; node: { id: string; title: string; kind: string } | null }

interface SourceSym { key: string; kind: string; name: string; container: string; start_line: number; end_line: number; owner: string | null }
interface Source { path: string; text: string; symbols: SourceSym[] }

/** The right pane: whatever the left pane selected — a node's description, or a file's source. */
export function Detail() {
  const picked = useStore((s) => s.picked);
  return <div className="pane detail">{picked ? <CodeView file={picked.file} symKey={picked.key} /> : <NodeView />}</div>;
}

// ---------- code ----------

function CodeView({ file, symKey }: { file: string; symKey?: string }) {
  const { nodes, setSelected, setFocus } = useStore();
  const [src, setSrc] = useState<Source | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSrc(null); setErr(null);
    api<Source>(`/source?file=${encodeURIComponent(file)}`).then(setSrc).catch((e) => setErr(e.message));
  }, [file]);

  const sym = src?.symbols.find((s) => s.key === symKey) ?? null;
  useEffect(() => {
    if (!sym || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(`[data-line="${sym.start_line}"]`);
    el?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [sym?.key, src]);

  const lines = useMemo(() => (src ? src.text.split("\n") : []), [src]);
  const ownerOf = (id: string | null) => (id ? nodes[id] : null);
  const goto = (id: string) => { const n = nodes[id]; if (!n) return; setFocus(n.kind === "intent" ? n.id : n.parent); setSelected(n.id); };

  // which node owns the symbol under each line, so the gutter can show ownership at a glance
  const ownerByLine = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of src?.symbols ?? []) if (s.owner) for (let l = s.start_line; l <= s.end_line; l++) m.set(l, s.owner);
    return m;
  }, [src]);

  const owners = [...new Set((src?.symbols ?? []).map((s) => s.owner).filter(Boolean))] as string[];

  return (
    <>
      <div className="detail-bar">
        <span className="detail-title" title={file}>{file}</span>
        {sym && <span className="dim">{sym.kind} {sym.container ? sym.container + "." : ""}{sym.name}</span>}
        <span className="detail-actions">
          {sym?.owner && ownerOf(sym.owner) && <button onClick={() => goto(sym.owner!)}>owner: {ownerOf(sym.owner)!.title.slice(0, 28)} →</button>}
          {sym && !sym.owner && <span className="tag warn">unowned</span>}
          {!sym && owners.length > 0 && <span className="dim">{owners.length} owning node{owners.length > 1 ? "s" : ""}</span>}
          {!sym && !owners.length && src && <span className="tag warn">no node owns this file</span>}
        </span>
      </div>
      <div className="detail-body code" ref={bodyRef}>
        {err && <div className="bad">{err}</div>}
        {!src && !err && <div className="dim">loading…</div>}
        {src && lines.map((ln, i) => {
          const no = i + 1;
          const inSym = sym && no >= sym.start_line && no <= sym.end_line;
          const own = ownerByLine.get(no);
          return (
            <div key={no} data-line={no} className={`codeline ${inSym ? "in-symbol" : ""}`}>
              <span className="gutter" style={own ? { borderLeftColor: areaColor(nodes, own) } : undefined}
                    title={own ? nodes[own]?.title : "no node owns this line"}>{no}</span>
              <span className="src">{ln || " "}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- node ----------

function NodeView() {
  const { selected, focus, nodes, runs, notify } = useStore();
  const id = selected ?? focus;
  const n = id ? nodes[id] : null;
  const [tab, setTab] = useState<Tab>("spec");
  const [src, setSrc] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => { setSrc(null); setTab("spec"); }, [id]);

  const act = (path: string, body?: any) => api(path, body ?? {}).catch((e) => notify(e.message));
  if (!n) return (
    <>
      <div className="detail-bar"><span className="dim">nothing selected</span></div>
      <div className="detail-body"><div className="hint">pick a node or a file on the left.</div><EntryPoints /></div>
    </>
  );

  const col = areaColor(nodes, n.id);
  const run = runs.find((r: any) => r.id === n.last_run);
  const v = n.verification;

  return (
    <>
      <div className="detail-bar">
        <span className="detail-title" style={{ color: col }} title={n.title}>{n.title}</span>
        <StatusTag status={n.status} />
        <span className="dim">{n.kind}</span>
        {n.staged && <span className="tag accent">staged</span>}
        {n.needs_reverify && <span className="tag warn">needs-reverify</span>}
        <span className="detail-actions">
          {n.status === "proposed" && <button className="primary" onClick={() => act(`/nodes/${n.id}/approve`)}>approve</button>}
          {(n.status === "specified" || n.status === "rejected") && n.kind === "behavior" && <button className="primary" onClick={() => act(`/nodes/${n.id}/dispatch`)}>dispatch</button>}
          {(n.status === "built" || n.status === "drifted") && <button className="primary" onClick={() => act(`/nodes/${n.id}/approve`)}>approve</button>}
          <button onClick={() => act(`/nodes/${n.id}/summarize`)}>{n.summary ? "re-summarize" : "summarize"}</button>
          {(n.kind === "intent" ? n.derived : (n.anchors ?? []).length > 0) && <button onClick={() => deriveNode(n)}>regenerate</button>}
        </span>
      </div>
      <div className="detail-tabs">{TABS.map((t) => <span key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</span>)}</div>
      <div className="detail-body">
        {n.status === "drifted" && <div className="box bad">drift: {n.drift?.reasons.join("; ")}<div className="row"><button onClick={() => act(`/nodes/${n.id}/drift`, { action: "holds" })}>spec still holds</button><button onClick={() => act(`/nodes/${n.id}/drift`, { action: "rebuild" })}>re-build</button></div></div>}
        {v?.rejection_note && n.status !== "verified" && <div className="box"><span className="dim">rejection note:</span> {v.rejection_note}</div>}

        {tab === "spec" && <>
          {n.summary && <><div className="section-h">summary</div><div style={{ lineHeight: 1.55, marginBottom: 14 }}><Summary text={n.summary} /></div></>}
          <div className="section-h">spec</div>
          <pre>{n.spec || <span className="dim">(no spec — press e to edit)</span>}</pre>
          <div className="dim" style={{ marginTop: 10 }}>{n.id}{n.parent ? ` · under ${nodes[n.parent]?.title ?? n.parent}` : " · root"}{n.deps.length ? ` · deps: ${n.deps.map((d: string) => nodes[d]?.title ?? d).join(", ")}` : ""}</div>
          <Relations id={n.id} />
        </>}

        {tab === "flow" && <FlowView id={n.id} />}

        {tab === "examples" && (n.examples?.length ? n.examples.map((e: any) => (
          <div className="box" key={e.id}><div><b>{e.name}</b> <span className="dim">{e.id}{e.derived ? " · derived" : ""}</span></div>
            <div><span className="dim">given</span> {e.given}</div><div><span className="dim">when </span> {e.when}</div><div><span className="dim">then </span> {e.then}</div>
            <div className="dim">run: {e.run ?? "(not yet written)"} · expect: {e.expect?.mode ?? "exit0"}</div></div>
        )) : <div className="dim">{n.kind === "intent" ? "intent nodes have no examples" : "no examples"}</div>)}

        {tab === "anchors" && <>
          {(n.kind === "behavior" ? n.anchors ?? [] : []).map((a: any) => { const key = `${a.file}#${a.container}#${a.kind}#${a.name}`; return (
            <div key={key} className="box" style={{ cursor: "pointer" }} onClick={async () => { if (src?.key === key) return setSrc(null); const r = await api<{ source: string | null }>(`/symbols/${encodeURIComponent(key)}/source`); setSrc({ key, text: r.source }); }}>
              <span className="dim">{a.kind}</span> {a.container ? a.container + "." : ""}{a.name} <span className="dim">{a.file}</span>
              {src?.key === key && <pre style={{ marginTop: 6, fontSize: 12 }}>{src.text ?? "(symbol not found on disk)"}</pre>}
            </div>); })}
          {n.kind === "intent" && <div className="dim">intent: symbols are the union of descendants' anchors</div>}
          {n.kind === "behavior" && !(n.anchors ?? []).length && <div className="dim">no anchored symbols yet</div>}
        </>}

        {tab === "verify" && <>
          {run && <div className="box"><span className="dim">last run</span> {run.id} · {run.status} · {run.duration ? `${Math.round(run.duration)}s` : ""} {run.cost_usd ? `· $${run.cost_usd.toFixed(3)}` : ""}{run.error && <div className="bad">{run.error}</div>}</div>}
          <div className="box">examples: {v?.examples ? <span><span className="ok">{v.examples.pass} pass</span> · <span className={v.examples.fail ? "bad" : ""}>{v.examples.fail} fail</span> · {v.examples.pending} pending</span> : <span className="dim">not run</span>}</div>
          <div className="box">machine: {v?.machine ? <span className={v.machine.ok ? "ok" : "bad"}>{v.machine.ok ? "ok" : `failed (exit ${v.machine.exit})`}</span> : <span className="dim">{n.machine?.run ? "not run" : "no machine check"}</span>}</div>
          <div className="box">reconstruction: {v?.reconstruction ? <span className={v.reconstruction.verdict === "match" ? "ok" : "bad"}>{v.reconstruction.verdict}</span> : <span className="dim">pending</span>}</div>
          {v?.approved_by && <div className="dim">approved by {v.approved_by} at {v.approved_at}</div>}
          <div className="row"><button onClick={() => act(`/nodes/${n.id}/verify`)}>re-run examples</button><button onClick={() => act(`/nodes/${n.id}/reconstruct`)}>re-reconstruct</button></div>
        </>}

        {tab === "reconstruction" && <pre>{n.reconstruction ?? <span className="dim">no reconstruction yet — produced after a build</span>}</pre>}
      </div>
    </>
  );
}

/** goto helper shared by the flow and relation views */
function useGoto() {
  const nodes = useStore((s) => s.nodes);
  const setFocus = useStore((s) => s.setFocus); const setSelected = useStore((s) => s.setSelected);
  return (id: string) => { const x = nodes[id]; if (!x) return; setFocus(x.kind === "intent" ? x.id : x.parent); setSelected(x.id); };
}

/**
 * Logic flow at this node's level of abstraction: an indented outline of what it calls into and what reaches it,
 * ordered by where the call appears in the source. Read straight off the index — no model involved, so it is exact.
 */
function FlowView({ id }: { id: string }) {
  const nodes = useStore((s) => s.nodes);
  const go = useGoto();
  const [flow, setFlow] = useState<{ out: FlowStep | null; in: FlowStep | null }>({ out: null, in: null });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true; setLoading(true);
    Promise.all([api<FlowStep>(`/nodes/${id}/flow?dir=out`), api<FlowStep>(`/nodes/${id}/flow?dir=in`)])
      .then(([o, i]) => { if (live) { setFlow({ out: o, in: i }); setLoading(false); } })
      .catch(() => live && setLoading(false));
    return () => { live = false; };
  }, [id]);

  const branch = (step: FlowStep | null) => (step?.children.length ? <Step step={step} depth={0} top /> : null);
  const out = branch(flow.out), inn = branch(flow.in);

  function Step({ step, depth, top }: { step: FlowStep; depth: number; top?: boolean }) {
    const col = areaColor(nodes, step.id);
    return (
      <div className="flowstep" style={{ marginLeft: depth > 1 ? 16 : 0 }}>
        {!top && (
          <div className="flowrow">
            <span className="dim flowarrow">→</span>
            <a className="nodelink" style={{ color: col, borderColor: col }} onClick={() => go(step.id)}>{step.title}</a>
            {step.via.length > 0 && <span className="dim flowvia" title={step.via.join("\n")}>{step.via[0]}{step.via.length > 1 ? ` +${step.via.length - 1}` : ""}</span>}
            {step.cycle && <span className="tag">calls back</span>}
            {step.repeat && <span className="tag dim-tag">expanded above</span>}
            {step.truncated && <span className="tag">…</span>}
          </div>
        )}
        {step.children.map((c, i) => <Step key={`${c.id}-${i}`} step={c} depth={depth + 1} />)}
      </div>
    );
  }

  if (loading) return <div className="dim">reading the call graph…</div>;
  if (!out && !inn) return <div className="dim">nothing calls this node and it calls nothing — either it owns no symbols yet, or its code stands alone.</div>;
  return (
    <>
      {out && <><div className="section-h">flows into</div>{out}</>}
      {inn && <><div className="section-h" style={{ marginTop: 14 }}>reached from</div>{inn}</>}
    </>
  );
}

/** Where execution starts: detected mains and pinned entry points, resolved to the node that owns them. */
function EntryPoints() {
  const nodes = useStore((s) => s.nodes);
  const go = useGoto();
  const [eps, setEps] = useState<EntryPoint[] | null>(null);
  useEffect(() => { let live = true; api<EntryPoint[]>("/flow/entries").then((e) => live && setEps(e)).catch(() => live && setEps([])); return () => { live = false; }; }, []);
  if (!eps?.length) return null;
  // several entry symbols often live in one node (a server's fetch/open/close): one row per node, not per symbol
  const rows = new Map<string, { node: EntryPoint["node"]; names: string[]; file: string }>();
  for (const e of eps) {
    const k = e.node?.id ?? `?${e.file}`;
    const r = rows.get(k) ?? { node: e.node, names: [], file: e.file };
    r.names.push(e.name); rows.set(k, r);
  }
  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-h">where execution starts</div>
      {[...rows].map(([k, r]) => (
        <div key={k} className="flowrow">
          {r.node
            ? <a className="nodelink" style={{ color: areaColor(nodes, r.node.id), borderColor: areaColor(nodes, r.node.id) }} onClick={() => go(r.node!.id)}>{r.node.title}</a>
            : <span className="tag warn">unowned</span>}
          <span className="dim flowvia">{r.names.join(", ")} · {r.file}</span>
        </div>
      ))}
    </div>
  );
}

/** peer-level call relations, as links with the symbol that connects them */
function Relations({ id }: { id: string }) {
  const nodes = useStore((s) => s.nodes); const rel = useStore((s) => s.relations[id]);
  const setFocus = useStore((s) => s.setFocus); const setSelected = useStore((s) => s.setSelected);
  if (!rel || (!rel.out.length && !rel.in.length)) return null;
  const go = (t: string) => { const x = nodes[t]; if (!x) return; setFocus(x.kind === "intent" ? x.id : x.parent); setSelected(x.id); };
  const list = (rs: { id: string; via: string[] }[]) => rs.filter((r) => nodes[r.id]).map((r) => (
    <div key={r.id} className="flow-link">
      <a className="nodelink" style={{ color: areaColor(nodes, r.id), borderColor: areaColor(nodes, r.id) }} onClick={() => go(r.id)}>{nodes[r.id].title}</a>
      {r.via.length > 0 && <span className="dim" title={r.via.join("\n")}> via {r.via[0]}{r.via.length > 1 ? ` +${r.via.length - 1}` : ""}</span>}
    </div>));
  return (
    <div className="flow-links" style={{ marginTop: 14 }}>
      {rel.out.length > 0 && <div><div className="section-h">calls</div>{list(rel.out)}</div>}
      {rel.in.length > 0 && <div><div className="section-h" style={{ marginTop: 8 }}>called by</div>{list(rel.in)}</div>}
    </div>
  );
}
