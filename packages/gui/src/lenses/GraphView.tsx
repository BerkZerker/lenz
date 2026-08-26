import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { areaColor, STATUS_RING, withAlpha } from "../colors";
import { Summary } from "../components/Summary";
import { StatusTag } from "../components/common";
import type { LenzNode } from "../types";

interface P { id: string; x: number; y: number; tx: number; ty: number; vx: number; vy: number; pinned?: boolean }
type Layout = "force" | "tree";
const ROOT = "__root__";
const LEAF_GAP = 230, LEVEL_GAP = 150;
/** rAF is paused in hidden tabs; fall back to a timer so layouts still settle (e.g. for screenshots). */
const schedule = (fn: (t: number) => void): number => (document.hidden ? (setTimeout(() => fn(performance.now()), 16) as unknown as number) | 0x40000000 : requestAnimationFrame(fn));
const unschedule = (id: number) => { if (id & 0x40000000) clearTimeout(id & ~0x40000000); else cancelAnimationFrame(id); };

/**
 * Voxel-style local graph: only the cursor (an intent or the root), its parent (the way up) and its ≤9 children are
 * loaded. Clicking an intent child moves the cursor there; clicking a behavior opens its panel. Zoom is never
 * changed by a click — only pans, smoothly. Node color = area (top-level subtree); ring = status.
 */
export function GraphView() {
  const { nodes, focus, selected, setSelected, setFocus, relations } = useStore();
  const [layout, setLayout] = useState<Layout>(() => { try { return (localStorage.getItem("lg.graphLayout") as Layout) || "tree"; } catch { return "tree"; } });
  const [seed, setSeed] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setViewRaw] = useState({ x: 0, y: 0, k: 1.3 });
  const viewRef = useRef(view); viewRef.current = view;
  const [, tick] = useState(0);
  const pos = useRef(new Map<string, P>());
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const anim = useRef(0);
  const lastCursorPos = useRef<{ x: number; y: number } | null>(null);
  const cursor = focus ?? ROOT;
  const parentId = focus ? (nodes[focus]?.parent ?? ROOT) : null;

  // ---- loaded set: parent + cursor + children ----
  const children = useMemo(() => Object.values(nodes).filter((n) => n.parent === focus).sort((a, b) => a.title.localeCompare(b.title)), [nodes, focus]);
  const loaded = useMemo(() => { const s = new Map<string, LenzNode | null>(); if (parentId) s.set(parentId, parentId === ROOT ? null : nodes[parentId]); s.set(cursor, focus ? nodes[focus] : null); for (const c of children) s.set(c.id, c); return s; }, [nodes, focus, children, cursor, parentId]);
  const relEdges = useMemo(() => {
    const out: { a: string; b: string; kind: "dep" | "calls" }[] = [];
    const ids = new Set(children.map((c) => c.id));
    for (const c of children) {
      for (const d of c.deps) if (ids.has(d)) out.push({ a: d, b: c.id, kind: "dep" });
      for (const r of relations[c.id]?.out ?? []) if (ids.has(r.id) && !c.deps.includes(r.id)) out.push({ a: c.id, b: r.id, kind: "calls" });
    }
    return out;
  }, [children, relations]);

  // ---- view animation ----
  const setView = (v: { x: number; y: number; k: number }, animate = true) => {
    unschedule(anim.current);
    if (!animate) { setViewRaw(v); return; }
    const from = { ...viewRef.current }; const t0 = performance.now(); const D = 380;
    const step = (t: number) => { const u = Math.min(1, (t - t0) / D); const e = 1 - Math.pow(1 - u, 3); setViewRaw({ x: from.x + (v.x - from.x) * e, y: from.y + (v.y - from.y) * e, k: from.k + (v.k - from.k) * e }); if (u < 1) anim.current = schedule(step); };
    anim.current = schedule(step);
  };
  const centerOn = (x: number, y: number, k = viewRef.current.k) => setView({ k, x: -x * k, y: -y * k });
  const fitAll = () => {
    const ps = [...pos.current.values()].map((p) => ({ x: p.tx, y: p.ty })); if (!ps.length || !svgRef.current) return;
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + 360, h = Math.max(...ys) - Math.min(...ys) + 160;
    const k = Math.min(1.8, Math.max(0.8, Math.min(svgRef.current.clientWidth / w, svgRef.current.clientHeight / h)));
    setView({ k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k });
  };

  // ---- layout targets ----
  useEffect(() => {
    const m = pos.current;
    const spawn = lastCursorPos.current ?? { x: 0, y: 0 };
    for (const id of [...m.keys()]) if (!loaded.has(id)) m.delete(id);
    for (const id of loaded.keys()) if (!m.has(id)) m.set(id, { id, x: spawn.x, y: spawn.y, tx: spawn.x, ty: spawn.y, vx: 0, vy: 0 });
    // re-anchor the coordinate system on the cursor: cursor at (0,0), parent above, children below
    const c = m.get(cursor)!; c.tx = 0; c.ty = 0; c.pinned = true;
    if (parentId) { const p = m.get(parentId)!; p.tx = 0; p.ty = -LEVEL_GAP; p.pinned = true; }
    const n = children.length;
    if (layout === "tree" || n === 0) {
      // fan: children on an arc below the cursor; wider arcs for more children, labels placed outward (see angleOf)
      const R = n <= 3 ? 190 : 170 + n * 22;
      const span = n <= 2 ? 0.5 : n <= 5 ? 0.8 : 1.0; // fraction of the lower half-circle
      children.forEach((ch, i) => { const p = m.get(ch.id)!; const t = n === 1 ? 0.5 : i / (n - 1); const a = Math.PI / 2 + (t - 0.5) * Math.PI * span; p.tx = Math.cos(a) * R * 1.35; p.ty = Math.sin(a) * R; p.pinned = true; });
    } else {
      // force: children start on an arc below the cursor and relax
      children.forEach((ch, i) => { const p = m.get(ch.id)!; const a = Math.PI * (0.15 + 0.7 * (n === 1 ? 0.5 : i / (n - 1))); p.tx = Math.cos(a) * 260 * (n > 4 ? 1.3 : 1); p.ty = Math.sin(a) * 200 + 60; p.pinned = false; });
    }
    lastCursorPos.current = { x: 0, y: 0 };
    let alpha = 1; let raf = 0;
    const step = () => {
      const ps = [...m.values()];
      let moving = false;
      if (layout === "force" && n > 0) {
        for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
          const A = ps[a], B = ps[b]; let dx = B.tx - A.tx, dy = B.ty - A.ty; const d2 = dx * dx + dy * dy || 1; const d = Math.sqrt(d2); const f = Math.min(80, 60000 / d2); dx /= d; dy /= d;
          if (!A.pinned) { A.vx -= dx * f; A.vy -= dy * f; } if (!B.pinned) { B.vx += dx * f; B.vy += dy * f; }
        }
        for (const ch of ps) { if (ch.pinned) continue; const dx = ch.tx - c.tx, dy = ch.ty - c.ty, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - 240) * 0.05; ch.vx -= (dx / d) * f; ch.vy -= (dy / d) * f; ch.vy += 0.6; /* gravity: children hang below */ }
        for (const p of ps) { if (p.pinned) continue; p.vx *= 0.55; p.vy *= 0.55; p.tx += p.vx * alpha; p.ty += p.vy * alpha; }
        alpha = Math.max(0.05, alpha * 0.98);
      }
      for (const p of ps) { const dx = p.tx - p.x, dy = p.ty - p.y; if (Math.abs(dx) + Math.abs(dy) > 0.3) { p.x += dx * 0.18; p.y += dy * 0.18; moving = true; } else { p.x = p.tx; p.y = p.ty; } }
      tick((t) => t + 1);
      if (moving || (layout === "force" && alpha > 0.06)) raf = schedule(step);
    };
    raf = schedule(step);
    // keep the cursor centered (pan only — zoom untouched)
    centerOn(0, LEVEL_GAP / 2);
    return () => unschedule(raf);
  }, [loaded, layout, seed, cursor]);

  useEffect(() => { const t = setTimeout(fitAll, 450); return () => clearTimeout(t); }, [layout, seed]); // fit only on layout switch / re-sort / mount

  // ---- interaction ----
  const onDown = (e: React.MouseEvent, id: string | null) => { e.stopPropagation(); const p = id ? pos.current.get(id) : null; drag.current = { id, sx: e.clientX, sy: e.clientY, ox: p ? p.tx : viewRef.current.x, oy: p ? p.ty : viewRef.current.y, moved: false }; };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current; if (!d) return; const dx = e.clientX - d.sx, dy = e.clientY - d.sy; if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.id) { const p = pos.current.get(d.id); if (p) { p.tx = p.x = d.ox + dx / viewRef.current.k; p.ty = p.y = d.oy + dy / viewRef.current.k; p.pinned = true; tick((t) => t + 1); } } else setView({ ...viewRef.current, x: d.ox + dx, y: d.oy + dy }, false);
  };
  const onUp = () => { drag.current = null; };
  const onWheel = (e: React.WheelEvent) => { const k = Math.min(3, Math.max(0.3, viewRef.current.k * (e.deltaY < 0 ? 1.1 : 0.9))); setView({ ...viewRef.current, k }, false); };
  const navigate = (id: string | null) => { const p = id ? pos.current.get(id) : pos.current.get(ROOT); lastCursorPos.current = p ? { x: p.x, y: p.y } : null; setFocus(id); setSelected(id); };
  const click = (id: string) => {
    if (drag.current?.moved) return;
    if (id === ROOT) { if (cursor !== ROOT) navigate(null); else setSelected(null); return; }
    const n = nodes[id]; if (!n) return;
    if (id === parentId) { navigate(n.id); return; }
    if (id !== cursor && n.kind === "intent") { navigate(id); return; }
    setSelected(selected === id ? null : id);
  };

  const sel = selected ? nodes[selected] : null;
  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: "app" }];
  let p = focus ? nodes[focus] : null; const chain: typeof crumbs = [];
  while (p) { chain.unshift({ id: p.id, title: p.title }); p = p.parent ? nodes[p.parent] : null; }
  crumbs.push(...chain);
  const colorOf = (id: string) => (id === ROOT ? "#d4d4d4" : areaColor(nodes, id));
  const connected = (id: string) => new Set(relEdges.filter((e) => e.a === id || e.b === id).flatMap((e) => [e.a, e.b]));
  const hi = hover ? connected(hover) : null;

  return (
    <div className="graph-wrap">
      <svg ref={svgRef} onMouseDown={(e) => onDown(e, null)} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel} style={{ cursor: drag.current && !drag.current.id ? "grabbing" : "default" }}>
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#666" /></marker></defs>
        <g transform={`translate(${(svgRef.current?.clientWidth ?? 800) / 2 + view.x}, ${(svgRef.current?.clientHeight ?? 500) / 2 + view.y}) scale(${view.k})`}>
          {/* containment edges */}
          {[...loaded.keys()].filter((id) => id !== cursor).map((id) => { const A = pos.current.get(id), C = pos.current.get(cursor); if (!A || !C) return null; const dim = hi && !hi.has(id) && hover !== id; return <line key={"c" + id} className="g-link" x1={C.x} y1={C.y} x2={A.x} y2={A.y} stroke={id === parentId ? "#555" : withAlpha(colorOf(id), 0.45)} strokeWidth={1.2} opacity={dim ? 0.25 : 1} />; })}
          {/* relation edges between siblings */}
          {relEdges.map((e, i) => { const A = pos.current.get(e.a), B = pos.current.get(e.b); if (!A || !B) return null; const on = hover === e.a || hover === e.b; const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const x2 = B.x - (dx / d) * 12, y2 = B.y - (dy / d) * 12; const bend = 28 * (i % 2 ? 1 : -1); return <path key={"r" + i} className="g-link" d={`M ${A.x} ${A.y} Q ${(A.x + B.x) / 2 - (dy / d) * bend} ${(A.y + B.y) / 2 + (dx / d) * bend} ${x2} ${y2}`} fill="none" stroke={e.kind === "dep" ? "#d97757" : colorOf(e.a)} strokeDasharray={e.kind === "dep" ? "5 3" : "2 3"} strokeWidth={on ? 1.8 : 1} opacity={hover ? (on ? 0.95 : 0.08) : 0.32} markerEnd="url(#arrow)" />; })}
          {[...loaded].map(([id, n]) => {
            const P = pos.current.get(id); if (!P) return null;
            const isCursor = id === cursor, isParent = id === parentId, isSel = id === selected, isIntent = !n || n.kind === "intent";
            const kids = Object.values(nodes).filter((x) => x.parent === (id === ROOT ? null : id)).length;
            const r = isCursor ? 15 : isParent ? 9 : isIntent ? 11 : 8;
            const col = colorOf(id); const ring = n ? STATUS_RING[n.status] : undefined;
            const title = id === ROOT ? "app" : n!.title;
            const dim = hi && !hi.has(id) && hover !== id && !isCursor && !isParent;
            return (
              <g key={id} className="g-node" transform={`translate(${P.x},${P.y})`} opacity={dim ? 0.35 : isParent ? 0.75 : 1} onMouseDown={(e) => onDown(e, id)} onClick={() => click(id)} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
                <circle className="halo" r={r + 10} fill={col} />
                <circle r={r} fill={isIntent ? "#0a0a0a" : col} stroke={isSel ? "#fff" : col} strokeWidth={isSel ? 2.5 : isIntent ? 1.8 : 1.2} strokeDasharray={n?.status === "proposed" ? "3 2" : undefined} />
                {ring && <circle r={r + 4} fill="none" stroke={ring} strokeWidth={1.5} opacity={0.9} />}
                {isIntent && kids > 0 && <text textAnchor="middle" dy="3.5" fontSize={9} fill={col} style={{ pointerEvents: "none" }}>{kids}</text>}
                {isParent && <text textAnchor="middle" y={-r - 6} fontSize={9} fill="#737373" style={{ pointerEvents: "none" }}>▲ up</text>}
                {(() => { const lp = labelPos(P, r, isCursor || isParent); return <>
                  <text className="lbl" textAnchor={lp.anchor} x={lp.x} y={lp.y} fontSize={isCursor ? 13 : 12} fontWeight={isCursor ? 700 : 400} fill={isSel ? "#fff" : "#d4d4d4"} style={{ userSelect: "none" }}>{trunc(title, 30)}</text>
                  {n?.staged && <text textAnchor={lp.anchor} x={lp.x} y={lp.y + 12} fontSize={10} fill="#d97757">staged</text>}
                </>; })()}
              </g>);
          })}
        </g>
      </svg>

      <div className="graph-toolbar glass">
        <span className="breadcrumb" style={{ margin: 0 }}>{crumbs.map((c, i) => <span key={c.id ?? "root"} className={i === crumbs.length - 1 ? "here" : ""} onClick={() => navigate(c.id)}>{trunc(c.title, 22)}{i < crumbs.length - 1 ? " ▸ " : ""}</span>)}</span>
        <span className="dim">· {children.length} loaded</span>
        <span style={{ width: 8 }} />
        <button className={layout === "force" ? "primary" : ""} onClick={() => { setLayout("force"); try { localStorage.setItem("lg.graphLayout", "force"); } catch {} }}>force</button>
        <button className={layout === "tree" ? "primary" : ""} onClick={() => { setLayout("tree"); try { localStorage.setItem("lg.graphLayout", "tree"); } catch {} }}>tree</button>
        <button onClick={() => { pos.current.clear(); setSeed((s) => s + 1); }}>re-sort</button>
        <button onClick={fitAll}>fit</button>
      </div>
      <div className="graph-hint">click intent: go there · click behavior: details · ▲ up · drag: pan · wheel: zoom</div>

      <Minimap nodes={nodes} focus={focus} onGo={navigate} />
      {sel && <NodePanel n={sel} onClose={() => setSelected(null)} onOpen={() => navigate(sel.id)} />}
    </div>
  );
}

function Minimap({ nodes, focus, onGo }: { nodes: Record<string, LenzNode>; focus: string | null; onGo: (id: string | null) => void }) {
  const levels: { parent: string | null; current: string | null }[] = [];
  let cur: string | null = focus;
  const chain: string[] = []; while (cur) { chain.unshift(cur); cur = nodes[cur]?.parent ?? null; }
  let parent: string | null = null;
  for (const id of chain) { levels.push({ parent, current: id }); parent = id; }
  levels.push({ parent: focus, current: null }); // the loaded children row
  return (
    <div className="minimap glass" title="where you are: each row is one level; the outlined dot is your path">
      <div className="lvl"><div className={`mdot ${focus === null ? "cur" : ""}`} style={{ background: "#d4d4d4" }} onClick={() => onGo(null)} /><span className="lbl">app</span></div>
      {levels.map((l, i) => {
        const sibs = Object.values(nodes).filter((n) => n.parent === l.parent).sort((a, b) => a.title.localeCompare(b.title));
        if (!sibs.length) return null;
        return <div className="lvl" key={i} style={{ paddingLeft: 6 * (i + 1) }}>
          {sibs.map((s) => <div key={s.id} className={`mdot ${s.id === l.current ? "cur" : ""}`} style={{ background: s.kind === "intent" ? "transparent" : areaColor(nodes, s.id), borderColor: areaColor(nodes, s.id) }} title={s.title} onClick={() => onGo(s.kind === "intent" ? s.id : s.parent)} />)}
          <span className="lbl">{l.current ? nodes[l.current]?.title : `${sibs.length} here`}</span>
        </div>;
      })}
    </div>
  );
}

function NodePanel({ n, onClose, onOpen }: { n: LenzNode; onClose: () => void; onOpen: () => void }) {
  const nodes = useStore((s) => s.nodes); const notify = useStore((s) => s.notify); const setLens = useStore((s) => s.setLens); const setFlowFrom = useStore((s) => s.setFlowFrom);
  const col = areaColor(nodes, n.id);
  const firstAnchor = (n.anchors ?? [])[0];
  const v = n.verification;
  const act = (path: string, body?: any) => api(path, body ?? {}).catch((e) => notify(e.message));
  return (
    <div className="node-panel glass" onMouseDown={(e) => e.stopPropagation()}>
      <div className="bar" style={{ background: col }} />
      <button className="close" onClick={onClose} title="close (esc)">×</button>
      <h4 style={{ color: col, paddingRight: 20 }}>{n.title}</h4>
      <div className="row" style={{ margin: "0 0 6px" }}><span className="dim">{n.kind}</span><StatusTag status={n.status} />{n.staged && <span className="tag accent">staged</span>}{n.needs_reverify && <span className="tag warn">needs-reverify</span>}{n.derived && <span className="tag">derived</span>}</div>
      {n.summary ? <div className="summary"><Summary text={n.summary} /></div> : <div className="summary dim">{n.spec ? trunc(n.spec, 420) : "(no spec)"}</div>}
      {n.summary && n.spec && <details><summary className="dim" style={{ cursor: "pointer" }}>spec</summary><pre className="dim" style={{ fontSize: 12, marginTop: 4 }}>{n.spec}</pre></details>}
      {n.kind === "behavior" && <div className="dim" style={{ marginTop: 6 }}>{(n.examples ?? []).length} examples · {(n.anchors ?? []).length} symbols{v?.examples ? ` · ex ${v.examples.pass}/${v.examples.pass + v.examples.fail + v.examples.pending}` : ""}{v?.reconstruction ? ` · recon ${v.reconstruction.verdict}` : ""}</div>}
      {n.status === "drifted" && <div className="bad" style={{ marginTop: 6 }}>drift: {n.drift?.reasons.join("; ")}</div>}
      <div className="actions">
        {n.kind === "intent" && <button className="primary" onClick={onOpen}>open →</button>}
        {n.status === "proposed" && <button className="primary" onClick={() => act(`/nodes/${n.id}/approve`)}>approve</button>}
        {(n.status === "specified" || n.status === "rejected") && n.kind === "behavior" && <button className="primary" onClick={() => act(`/nodes/${n.id}/dispatch`)}>dispatch</button>}
        {(n.status === "built" || n.status === "drifted") && <button className="primary" onClick={() => act(`/nodes/${n.id}/approve`)}>approve</button>}
        {firstAnchor && <button onClick={() => { setFlowFrom(`${firstAnchor.file}#${firstAnchor.container}#${firstAnchor.kind}#${firstAnchor.name}`); setLens("flow"); }} title="open the logical execution flow from this node's code">flow →</button>}
        <button onClick={() => act(`/nodes/${n.id}/summarize`)} title="rewrite the summary with Gemini">{n.summary ? "re-summarize" : "summarize"}</button>
      </div>
    </div>
  );
}
/** Labels go outward from the cursor (which sits at the origin): left nodes read leftward, right nodes rightward, bottom nodes below. */
function labelPos(P: { x: number; y: number }, r: number, centered: boolean): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  if (centered || (Math.abs(P.x) < 40 && P.y >= 0)) return { x: 0, y: r + 14, anchor: "middle" };
  if (Math.abs(P.x) < 40) return { x: 0, y: -r - 6, anchor: "middle" };
  const below = P.y > 60 ? 4 : 4;
  return P.x < 0 ? { x: -r - 6, y: below, anchor: "end" } : { x: r + 6, y: below, anchor: "start" };
}
function trunc(s: string, n: number) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
