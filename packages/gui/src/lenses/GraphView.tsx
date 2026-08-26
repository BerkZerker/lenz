import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import type { LenzNode } from "../types";

interface P { id: string; x: number; y: number; vx: number; vy: number; pinned?: boolean }
const COLORS: Record<string, string> = { specified: "#737373", building: "#3b82f6", built: "#eab308", verified: "#22c55e", rejected: "#ef4444", drifted: "#ef4444", proposed: "#a3a3a3" };
const ROOT = "__root__";

/** Obsidian-style local graph: focus in the center, children around it, click to expand, double-click to re-center. */
export function GraphView() {
  const { nodes, focus, selected, setSelected, setFocus } = useStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [, tick] = useState(0);
  const pos = useRef(new Map<string, P>());
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const centerId = focus ?? ROOT;
  // default: intent children of the center are expanded one level so a folder shows its behaviors immediately
  useEffect(() => { setExpanded(new Set(Object.values(nodes).filter((n) => n.parent === focus && n.kind === "intent").map((n) => n.id))); }, [focus, Object.keys(nodes).length]);

  // visible set: center + its children + children of expanded nodes (recursively, only if their parent is visible)
  const visible = useMemo(() => {
    const all = Object.values(nodes);
    const set = new Map<string, LenzNode | null>();
    set.set(centerId, focus ? nodes[focus] ?? null : null);
    const addChildren = (pid: string | null) => { for (const n of all) if (n.parent === pid) { if (!set.has(n.id)) { set.set(n.id, n); if (expanded.has(n.id)) addChildren(n.id); } } };
    addChildren(focus);
    return set;
  }, [nodes, focus, expanded, centerId]);

  const links = useMemo(() => {
    const out: { a: string; b: string; kind: "child" | "dep" }[] = [];
    for (const [id, n] of visible) {
      if (id === centerId) continue;
      const p = n?.parent ?? ROOT;
      if (visible.has(p) || (p === ROOT && centerId === ROOT)) out.push({ a: visible.has(p) ? p : centerId, b: id, kind: "child" });
      else if (n && n.parent === focus) out.push({ a: centerId, b: id, kind: "child" });
      for (const d of n?.deps ?? []) if (visible.has(d)) out.push({ a: d, b: id, kind: "dep" });
    }
    return out;
  }, [visible, centerId, focus]);

  // simulation
  useEffect(() => {
    const m = pos.current;
    for (const id of [...m.keys()]) if (!visible.has(id)) m.delete(id);
    let i = 0;
    for (const id of visible.keys()) {
      if (!m.has(id)) {
        const parent = visible.get(id)?.parent ?? centerId; const pp = m.get(parent) ?? m.get(centerId);
        const a = (i++ / Math.max(1, visible.size)) * Math.PI * 2;
        m.set(id, { id, x: (pp?.x ?? 0) + Math.cos(a) * 160 + (Math.random() - 0.5) * 40, y: (pp?.y ?? 0) + Math.sin(a) * 160 + (Math.random() - 0.5) * 40, vx: 0, vy: 0 });
      }
    }
    const c = m.get(centerId)!; c.x = 0; c.y = 0; c.pinned = true;
    let alpha = 1; let raf = 0;
    const step = () => {
      const ps = [...m.values()];
      for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
        const A = ps[a], B = ps[b]; let dx = B.x - A.x, dy = B.y - A.y; let d2 = dx * dx + dy * dy || 1; const d = Math.sqrt(d2);
        const f = Math.min(80, 40000 / d2); dx /= d; dy /= d;
        A.vx -= dx * f; A.vy -= dy * f; B.vx += dx * f; B.vy += dy * f;
      }
      for (const l of links) {
        const A = m.get(l.a), B = m.get(l.b); if (!A || !B) continue;
        const rest = l.kind === "dep" ? 260 : 190 + Math.min(4, (visible.get(l.b) ? childCount(nodes, l.b) : 0)) * 15;
        const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - rest) * (l.kind === "dep" ? 0.01 : 0.04);
        A.vx += (dx / d) * f; A.vy += (dy / d) * f; B.vx -= (dx / d) * f; B.vy -= (dy / d) * f;
      }
      for (const p of ps) {
        p.vx -= p.x * 0.01; p.vy -= p.y * 0.01; // gentle centering
        if (p.pinned) { p.vx = p.vy = 0; continue; }
        p.vx *= 0.6; p.vy *= 0.6; p.x += p.vx * alpha; p.y += p.vy * alpha;
      }
      alpha = Math.max(0.05, alpha * 0.985);
      tick((t) => t + 1);
      if (alpha > 0.06) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [visible, links, centerId]);

  const toSvg = (cx: number, cy: number) => { const r = svgRef.current!.getBoundingClientRect(); return { x: (cx - r.left - r.width / 2 - view.x) / view.k, y: (cy - r.top - r.height / 2 - view.y) / view.k }; };
  const onDown = (e: React.MouseEvent, id: string | null) => { e.stopPropagation(); const p = id ? pos.current.get(id) : null; drag.current = { id, sx: e.clientX, sy: e.clientY, ox: p ? p.x : view.x, oy: p ? p.y : view.y, moved: false }; if (p) p.pinned = true; };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current; if (!d) return; const dx = e.clientX - d.sx, dy = e.clientY - d.sy; if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.id) { const p = pos.current.get(d.id); if (p) { p.x = d.ox + dx / view.k; p.y = d.oy + dy / view.k; tick((t) => t + 1); } } else setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
  };
  const onUp = () => { const d = drag.current; if (d?.id && d.id !== centerId) { const p = pos.current.get(d.id); if (p) p.pinned = false; } drag.current = null; };
  const onWheel = (e: React.WheelEvent) => { const k = Math.min(3, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 0.9))); setView((v) => ({ ...v, k })); };
  const click = (id: string) => { if (drag.current?.moved) return; if (id === ROOT) { setSelected(null); return; } setSelected(id); setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const dbl = (id: string) => { const n = nodes[id]; if (id === ROOT) { setFocus(null); return; } if (n?.kind === "intent") { setFocus(id); setSelected(null); setExpanded(new Set()); } };

  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: "app" }];
  let p = focus ? nodes[focus] : null; const chain: typeof crumbs = [];
  while (p) { chain.unshift({ id: p.id, title: p.title }); p = p.parent ? nodes[p.parent] : null; }
  crumbs.push(...chain);
  void toSvg;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="breadcrumb">{crumbs.map((c, i) => <span key={c.id ?? "root"} className={i === crumbs.length - 1 ? "here" : ""} onClick={() => { setFocus(c.id); setSelected(null); setExpanded(new Set()); }}>{c.title}{i < crumbs.length - 1 ? " ▸ " : ""}</span>)}
        <span className="dim" style={{ float: "right" }}>click: select + expand · double-click: center · drag: pan · wheel: zoom</span></div>
      <svg ref={svgRef} style={{ flex: 1, width: "100%", minHeight: 400, cursor: drag.current ? "grabbing" : "default" }} onMouseDown={(e) => onDown(e, null)} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
        <g transform={`translate(${(svgRef.current?.clientWidth ?? 800) / 2 + view.x}, ${(svgRef.current?.clientHeight ?? 500) / 2 + view.y}) scale(${view.k})`}>
          {links.map((l, i) => { const A = pos.current.get(l.a), B = pos.current.get(l.b); if (!A || !B) return null; return <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={l.kind === "dep" ? "#d97757" : "#333"} strokeDasharray={l.kind === "dep" ? "4 3" : undefined} strokeWidth={1} />; })}
          {[...visible].map(([id, n]) => {
            const P = pos.current.get(id); if (!P) return null;
            const isCenter = id === centerId; const sel = id === selected; const isIntent = !n || n.kind === "intent";
            const kids = id === ROOT ? childCount(nodes, null) : childCount(nodes, id);
            const r = isCenter ? 14 : isIntent ? 10 : 7;
            const col = n ? COLORS[n.status] ?? "#737373" : "#d4d4d4";
            const title = id === ROOT ? "app" : n!.title;
            return (
              <g key={id} transform={`translate(${P.x},${P.y})`} onMouseDown={(e) => onDown(e, id)} onClick={() => click(id)} onDoubleClick={() => dbl(id)} style={{ cursor: "pointer" }}>
                <circle r={r} fill={isIntent ? "#0a0a0a" : col} stroke={sel ? "#d97757" : col} strokeWidth={sel ? 2 : 1.5} strokeDasharray={n?.status === "proposed" ? "3 2" : undefined} />
                {isIntent && kids > 0 && <text textAnchor="middle" dy="3.5" fontSize={9} fill="#d4d4d4">{kids}</text>}
                <text x={r + 5} dy="4" fontSize={isCenter ? 13 : 12} fill={sel ? "#d97757" : "#d4d4d4"} style={{ userSelect: "none" }}>{trunc(title, isCenter ? 60 : 34)}</text>
                {n?.staged && <text x={r + 5} dy="16" fontSize={10} fill="#d97757">staged</text>}
                {sel && n && n.spec && <foreignObject x={r + 5} y={10} width={260} height={110}><div style={{ font: "10.5px/1.35 JetBrains Mono, monospace", color: "#737373", background: "#0a0a0a", border: "1px solid #262626", padding: "3px 5px", overflow: "hidden", maxHeight: 104 }}>{trunc(n.spec, 260)}</div></foreignObject>}
              </g>);
          })}
        </g>
      </svg>
    </div>
  );
}
function childCount(nodes: Record<string, LenzNode>, id: string | null) { let c = 0; for (const n of Object.values(nodes)) if (n.parent === id) c++; return c; }
function trunc(s: string, n: number) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
