import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store";
import { areaColor, STATUS_RING, withAlpha } from "../../colors";
import type { LenzNode } from "../../types";
import { deriveGraph } from "../../derive";

interface P { id: string; x: number; y: number; tx: number; ty: number; vx: number; vy: number; pinned?: boolean }
type Layout = "force" | "tree";
const ROOT = "__root__";
const NOMINAL = 1000; // only node *positions* live in these units; glyphs are drawn at a fixed on-screen size
// glyph metrics, in CSS px — labels stay this size at every zoom level, so the fit reserves px, not layout units
const MAX_SHIFT_LINES = 2;
const LABEL_PX = 12.5, LABEL_LINE = 17, LABEL_CHARS = 24, LABEL_LINES = 3, CHAR_PX = LABEL_PX * 0.62, LABEL_GAP = 8, NODE_PX = 20;
const INSET_BASE = { l: 18, r: 18, t: 14, b: 14 };

/** Titles are long; wrapped lines beat one truncated line you cannot tell apart from its neighbour. */
function labelLines(title: string, chars = LABEL_CHARS, maxLines = LABEL_LINES): string[] {
  const words = (title ?? "").replace(/\s+/g, " ").trim().split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= chars) cur += " " + w;
    else { out.push(cur); cur = w; if (out.length === maxLines - 1) break; }
  }
  if (cur && out.length < maxLines) out.push(cur);
  const used = out.join(" ").length;
  const rest = (title ?? "").replace(/\s+/g, " ").trim().slice(used).trim();
  if (rest) { const last = out[out.length - 1]; out[out.length - 1] = (last + " " + rest).slice(0, chars - 1).trim() + "…"; }
  return out.length ? out : [""];
}
const labelPx = (title: string, chars?: number, lines?: number) => Math.max(...labelLines(title, chars, lines).map((l) => l.length)) * CHAR_PX;
/** rAF is paused in hidden tabs; fall back to a timer so layouts still settle (e.g. for screenshots). */
const schedule = (fn: (t: number) => void): number => (document.hidden ? (setTimeout(() => fn(performance.now()), 16) as unknown as number) | 0x40000000 : requestAnimationFrame(fn));
const unschedule = (id: number) => { if (id & 0x40000000) clearTimeout(id & ~0x40000000); else cancelAnimationFrame(id); };

/**
 * Voxel-style local graph: only the cursor (an intent or the root), its parent (the way up) and its ≤9 children are
 * loaded. Clicking an intent child moves the cursor there; clicking a behavior opens its panel. Zoom is never
 * changed by a click — only pans, smoothly. Node color = area (top-level subtree); ring = status.
 */
export function GraphView({ onCards }: { onCards?: () => void }) {
  const { nodes, focus, selected, setSelected, setFocus, relations, status } = useStore();
  const deriving = status?.deriving ?? null;
  const generated = useMemo(() => Object.values(nodes).some((n) => n.derived), [nodes]);
  const [layout, setLayout] = useState<Layout>(() => { try { return (localStorage.getItem("lg.graphLayout") as Layout) || "tree"; } catch { return "tree"; } });
  const [seed, setSeed] = useState(0);
  // flow mode: relation edges become directed, animated call arrows; the selected/hovered node's downstream chain is traced
  const [flowMode, setFlowMode] = useState<boolean>(() => { try { return localStorage.getItem("lg.graphFlow") === "1"; } catch { return false; } });
  const toggleFlow = () => setFlowMode((f) => { try { localStorage.setItem("lg.graphFlow", f ? "0" : "1"); } catch {} return !f; });
  const [hover, setHover] = useState<string | null>(null);
  const [view, setViewRaw] = useState({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view); viewRef.current = view;
  const [, tick] = useState(0);
  const pos = useRef(new Map<string, P>());
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const drag = useRef<{ id: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const anim = useRef(0);
  const lastCursorPos = useRef<{ x: number; y: number } | null>(null);
  const fitKey = useRef("");
  const cursor = focus ?? ROOT;
  const parentId = focus ? (nodes[focus]?.parent ?? ROOT) : null;

  // the canvas is whatever space the pane gives it; every zoom decision is made against the measured box,
  // so the graph looks the same relative to its container at any window size or screen resolution
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect(); const w = Math.round(r.width), h = Math.round(r.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure(); // a hidden tab never runs the rendering steps that flush ResizeObserver, so take the first measure directly
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  // ---- loaded set: parent + cursor + children ----
  const children = useMemo(() => Object.values(nodes).filter((n) => n.parent === focus).sort((a, b) => a.title.localeCompare(b.title)), [nodes, focus]);
  const loaded = useMemo(() => { const s = new Map<string, LenzNode | null>(); if (parentId) s.set(parentId, parentId === ROOT ? null : nodes[parentId]); s.set(cursor, focus ? nodes[focus] : null); for (const c of children) s.set(c.id, c); return s; }, [nodes, focus, children, cursor, parentId]);
  const relEdges = useMemo(() => {
    const out: { a: string; b: string; kind: "dep" | "calls"; via: string[] }[] = [];
    const ids = new Set(children.map((c) => c.id));
    for (const c of children) {
      for (const d of c.deps) if (ids.has(d)) out.push({ a: d, b: c.id, kind: "dep", via: [] });
      for (const r of relations[c.id]?.out ?? []) if (ids.has(r.id) && !c.deps.includes(r.id)) out.push({ a: c.id, b: r.id, kind: "calls", via: r.via });
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
  /** Widest label among the loaded nodes, in px — what the fit has to keep clear on the left and right. */
  // a crowded level cannot afford full-length labels: shorten them rather than let neighbours overlap.
  // how many lines each label may use falls out of the vertical room per row, not a guess.
  const dense = children.length >= 6;
  const rowPitch = useMemo(() => {
    if (!dense) return Infinity;
    const rows = Math.ceil(children.length / 2);
    return (Math.max(120, (size.h || 600) - INSET_BASE.t - INSET_BASE.b) - NODE_PX * 3) / Math.max(1, rows - 1);
  }, [dense, children.length, size.h]);
  const lblLines = !dense ? LABEL_LINES : rowPitch >= LABEL_LINE * 2 + 12 ? 2 : 1;
  const lblChars = dense ? (lblLines === 1 ? 26 : 18) : LABEL_CHARS;
  const padX = useMemo(() => {
    const titles = [...loaded].map(([id, n]) => (id === ROOT ? "app" : n?.title ?? ""));
    return NODE_PX + LABEL_GAP + Math.max(40, ...titles.map((t) => labelPx(t, lblChars, lblLines)));
  }, [loaded, lblChars, lblLines]);
  const padY = NODE_PX + LABEL_LINE * (lblLines + MAX_SHIFT_LINES) + 8;

  /**
   * Zoom so the loaded nodes fill the measured canvas. Labels and node circles are drawn at a constant on-screen
   * size, so their room is reserved in px and only the *positions* scale with k. `ifNeeded` only ever zooms out.
   */
  const fitAll = useCallback((ifNeeded = false, measured = false) => {
    const ps = [...pos.current.values()]; if (!ps.length) return;
    // read the canvas here rather than trusting state: ResizeObserver does not deliver in a background tab, so a
    // dock resize would otherwise leave us fitting to a stale height and hanging labels off the bottom.
    const box = wrapRef.current?.getBoundingClientRect();
    const W = Math.round(box?.width || size.w), H = Math.round(box?.height || size.h);
    if (!W || !H) return;
    if (W !== size.w || H !== size.h) setSize({ w: W, h: H });
    const xs = ps.map((p) => p.tx), ys = ps.map((p) => p.ty);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const spreadX = Math.max(1, maxX - minX), spreadY = Math.max(1, maxY - minY);
    const availW = Math.max(80, W - INSET_BASE.l - INSET_BASE.r), availH = Math.max(80, H - INSET_BASE.t - INSET_BASE.b);
    // glyph room is constant in px, so avail = k·spread + glyphPx solves exactly for k. `measured` reads the real
    // rendered bounds (labels, badges, any de-overlap shift) instead of estimating them.
    // glyph overhang, per side, in px — labels hang well below their node and barely above it, so the content is
    // not centred on the node positions and measuring one total would push the overhang off the bottom edge.
    let over = { l: padX, r: padX, t: padY, b: padY };
    if (measured && gRef.current) {
      try {
        const bb = gRef.current.getBBox(), kNow = viewRef.current.k;
        over = {
          l: Math.max(0, (minX - bb.x) * kNow), r: Math.max(0, (bb.x + bb.width - maxX) * kNow),
          t: Math.max(0, (minY - bb.y) * kNow), b: Math.max(0, (bb.y + bb.height - maxY) * kNow),
        };
      } catch {}
    }
    if (over.l + over.r + over.t + over.b <= 0) over = { l: padX, r: padX, t: padY, b: padY }; // bbox not settled yet
    const glyphX = over.l + over.r, glyphY = over.t + over.b;
    // 4% slack: an exact fit leaves no room for the de-overlap shift or sub-pixel rounding, and a label clips
    const SAFETY = 0.96;
    let k = Math.max(0.15, Math.min(3, SAFETY * Math.min((availW - glyphX) / spreadX, (availH - glyphY) / spreadY)));
    if (measured && gRef.current) { // hard guarantee: shrink until the painted bounds sit inside the canvas
      const bb = gRef.current.getBBox(), kNow = viewRef.current.k;
      const wPx = bb.width * kNow, hPx = bb.height * kNow;
      if (wPx > availW || hPx > availH) k = Math.min(k, kNow * SAFETY * Math.min(availW / wPx, availH / hPx));
    }
    if (ifNeeded && k >= viewRef.current.k) return; // already fits — leave the user's zoom alone
    // centre on the free rectangle, not on the whole canvas: the toolbar and minimap overlay the edges
    const cx = INSET_BASE.l + availW / 2 - W / 2, cy = INSET_BASE.t + availH / 2 - H / 2;
    // shift by half the overhang difference so the painted bounds are centred, not the bare node positions
    setView({ k, x: cx + (over.l - over.r) / 2 - ((maxX + minX) / 2) * k, y: cy + (over.t - over.b) / 2 - ((maxY + minY) / 2) * k });
  }, [size.w, size.h, padX, padY]);

  // ---- layout targets ----
  useEffect(() => {
    const m = pos.current;
    const spawn = lastCursorPos.current ?? { x: 0, y: 0 };
    for (const id of [...m.keys()]) if (!loaded.has(id)) m.delete(id);
    for (const id of loaded.keys()) if (!m.has(id)) m.set(id, { id, x: spawn.x, y: spawn.y, tx: spawn.x, ty: spawn.y, vx: 0, vy: 0 });
    // re-anchor the coordinate system on the cursor: cursor at (0,0), parent above, children below.
    // rx/ry come from the container's aspect, so a wide pane spreads the fan sideways and a tall one stacks it —
    // the level then fills the canvas in both axes instead of sitting in a band across the middle.
    const kids = children.length;
    const rx = NOMINAL * (kids <= 1 ? 0.1 : kids <= 2 ? 0.26 : kids <= 4 ? 0.34 : kids <= 6 ? 0.4 : 0.45);
    // shape the fan like the space actually left for positions (the canvas minus the room labels need), so the
    // fit ends up limited by width and height at the same time instead of leaving a band of dead canvas
    const freeW = Math.max(120, (size.w || 1200) - INSET_BASE.l - INSET_BASE.r - padX * 2);
    const freeH = Math.max(120, (size.h || 700) - INSET_BASE.t - INSET_BASE.b - padY * 2);
    const rows = parentId ? 1.78 : 1; // a parent row sits 0.78·ry above the cursor
    const ry = Math.min(rx * (dense ? 3.2 : 2.2), Math.max(rx * 0.36, ((rx * 2 * freeH) / freeW) / rows));
    const levelGap = ry * 0.78;
    const c = m.get(cursor)!; c.tx = 0; c.ty = 0; c.pinned = true;
    if (parentId) { const p = m.get(parentId)!; p.tx = 0; p.ty = -levelGap; p.pinned = true; }
    const n = kids;
    // a crowded level always uses the column list: force relaxation has no idea how wide a label is
    if (layout === "tree" || dense || n === 0) {
      if (dense) {
        // a wide fan puts long labels side by side and they collide; two columns give every label its own row,
        // read top-to-bottom down the left column then the right
        const half = Math.ceil(n / 2);
        children.forEach((ch, i) => {
          const p = m.get(ch.id)!;
          const left = i < half;
          const row = left ? i : i - half, inCol = left ? half : n - half;
          p.tx = (left ? -1 : 1) * rx * 0.66;
          p.ty = ry * (0.16 + (inCol === 1 ? 0.5 : row / (inCol - 1)) * 0.84);
          p.pinned = true;
        });
      } else {
        // fan: children spread across the width on a shallow arc, deepest in the middle; labels read outward
        children.forEach((ch, i) => {
          const p = m.get(ch.id)!;
          const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1; // -1 … 1
          p.tx = t * rx;
          p.ty = ry * (0.62 + 0.38 * Math.cos((t * Math.PI) / 2)) + (n >= 5 && i % 2 ? ry * 0.42 : 0);
          p.pinned = true;
        });
      }
    } else {
      // force: children start on the same arc and relax
      children.forEach((ch, i) => {
        const p = m.get(ch.id)!;
        const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        p.tx = t * rx * 0.8; p.ty = ry * (0.6 + 0.3 * Math.cos((t * Math.PI) / 2)); p.pinned = false;
      });
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
        for (const ch of ps) { if (ch.pinned) continue; const dx = ch.tx - c.tx, dy = ch.ty - c.ty, d = Math.sqrt(dx * dx + dy * dy) || 1; const f = (d - ry) * 0.05; ch.vx -= (dx / d) * f; ch.vy -= (dy / d) * f; ch.vy += 0.6; /* gravity: children hang below */ }
        for (const p of ps) { if (p.pinned) continue; p.vx *= 0.55; p.vy *= 0.55; p.tx += p.vx * alpha; p.ty += p.vy * alpha; }
        alpha = Math.max(0.05, alpha * 0.98);
      }
      for (const p of ps) { const dx = p.tx - p.x, dy = p.ty - p.y; if (Math.abs(dx) + Math.abs(dy) > 0.3) { p.x += dx * 0.18; p.y += dy * 0.18; moving = true; } else { p.x = p.tx; p.y = p.ty; } }
      tick((t) => t + 1);
      if (moving || (layout === "force" && alpha > 0.06)) raf = schedule(step);
    };
    raf = schedule(step);
    // keep the cursor centered (pan only), then zoom out if this level does not fit
    centerOn(0, levelGap / 2);
    // a resize, layout switch or re-sort re-fits outright; moving the cursor only zooms out if the level would clip
    const key = `${layout}|${seed}|${size.w}x${size.h}`;
    const hard = fitKey.current !== key; fitKey.current = key;
    const t = setTimeout(() => fitAll(!hard), hard ? 80 : 420);
    // …then polish against the real painted bounds. One pass can overshoot if the nodes were still gliding when it
    // measured, so run a few: each is idempotent once things have settled.
    const polish = [260, 560, 1000, 1500].map((d) => setTimeout(() => fitAll(false, true), d));
    return () => { unschedule(raf); clearTimeout(t); polish.forEach(clearTimeout); };
  }, [loaded, layout, seed, cursor, fitAll, size.w, size.h, padX, padY, dense]);

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

  const crumbs: { id: string | null; title: string }[] = [{ id: null, title: "app" }];
  let p = focus ? nodes[focus] : null; const chain: typeof crumbs = [];
  while (p) { chain.unshift({ id: p.id, title: p.title }); p = p.parent ? nodes[p.parent] : null; }
  crumbs.push(...chain);
  const inv = 1 / view.k; // glyphs are drawn inside a scale(1/k) group, so they keep a constant on-screen size

  /**
   * Last line of defence against unreadable labels: whatever the layout produced, walk the label boxes in screen
   * space and push any that still collide downwards. Node positions are untouched — only the text moves.
   */
  const { shift: labelShift, hide: labelHidden } = useMemo(() => {
    const k = view.k;
    const boxes: { id: string; x: number; y: number; w: number; h: number }[] = [];
    const fixed: typeof boxes = [];
    for (const [id, n] of loaded) {
      const p = pos.current.get(id); if (!p) continue;
      const roomy = id === cursor || id === parentId;
      const lines = labelLines(id === ROOT ? "app" : n?.title ?? "", roomy ? LABEL_CHARS : lblChars, roomy ? LABEL_LINES : lblLines);
      const w = Math.max(...lines.map((l) => l.length)) * CHAR_PX, h = lines.length * LABEL_LINE;
      const r = id === cursor ? 17 : id === parentId ? 11 : 13;
      const lp = labelPos(p, r, k, roomy, lines.length);
      // a label that reads *above* its node must never be nudged: pushing it down lands it on the node itself.
      // everything that reads below or beside one takes part, the cursor included — it is placed first (sorted by
      // y), so its neighbours move around it rather than it moving onto them.
      const x = p.tx * k + (lp.anchor === "end" ? lp.x - w : lp.anchor === "start" ? lp.x : lp.x - w / 2);
      const box = { id, x, y: p.ty * k + lp.y - LABEL_LINE, w, h };
      // one that reads above its node cannot be nudged (down lands it on the node), but it is still an obstacle
      // everything else has to route around
      (lp.y < 0 ? fixed : boxes).push(box);
    }
    boxes.sort((a, b) => a.y - b.y || a.x - b.x);
    // node circles and un-nudgeable labels are obstacles too: a label landing on a neighbour's circle covers its
    // child-count badge, and one landing on a fixed label makes both unreadable
    const placed: typeof boxes = [...fixed];
    for (const [id] of loaded) {
      const p = pos.current.get(id); if (!p) continue;
      const r = (id === cursor ? 17 : id === parentId ? 11 : 13) + 4;
      placed.push({ id: `#${id}`, x: p.tx * k - r, y: p.ty * k - r, w: r * 2, h: r * 2 });
    }
    const shift: Record<string, number> = {}, hide = new Set<string>();
    const clash = (b: { x: number; y: number; w: number; h: number }) =>
      placed.find((q) => b.x < q.x + q.w + 4 && b.x + b.w + 4 > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
    for (const b of boxes) {
      let dy = 0;
      for (let guard = 0; guard < 40; guard++) {
        const hit = clash({ ...b, y: b.y + dy });
        if (!hit) break;
        dy = hit.y + hit.h + 3 - b.y;
        if (dy > LABEL_LINE * MAX_SHIFT_LINES) break;
      }
      dy = Math.min(dy, LABEL_LINE * MAX_SHIFT_LINES); // bounded, and padY reserves exactly this much
      // if it still cannot be placed clear, do not draw it at all — unreadable overlapping text is worse than a
      // label you reveal by hovering, and the tree on the left names every node anyway
      if (clash({ ...b, y: b.y + dy })) { hide.add(b.id); continue; }
      shift[b.id] = dy;
      placed.push({ ...b, y: b.y + dy });
    }
    return { shift, hide };
  }, [loaded, view.k, cursor, parentId, lblChars, lblLines, seed, layout, size.w, size.h]);
  const colorOf = (id: string) => (id === ROOT ? "#e5e5e5" : areaColor(nodes, id));
  const connected = (id: string) => new Set(relEdges.filter((e) => e.a === id || e.b === id).flatMap((e) => [e.a, e.b]));
  // flow trace: hops downstream (calls) and upstream (called by) from the traced node, within the loaded level
  const traced = flowMode ? (hover ?? selected) : null;
  const trace = useMemo(() => {
    const down = new Map<string, number>(), up = new Map<string, number>();
    if (!traced) return { down, up };
    const walk = (m: Map<string, number>, dir: "a" | "b") => { m.set(traced, 0); const q = [traced]; while (q.length) { const x = q.shift()!; const h = m.get(x)!; for (const e of relEdges) { const from = dir === "a" ? e.a : e.b, to = dir === "a" ? e.b : e.a; if (from === x && !m.has(to)) { m.set(to, h + 1); q.push(to); } } } };
    walk(down, "a"); walk(up, "b");
    return { down, up };
  }, [traced, relEdges]);
  const hi = flowMode ? (traced ? new Set([...trace.down.keys(), ...trace.up.keys()]) : null) : hover ? connected(hover) : null;
  const flowEdgeState = (e: { a: string; b: string }) => { if (!traced) return "idle"; const dA = trace.down.get(e.a), dB = trace.down.get(e.b); if (dA !== undefined && dB === dA + 1) return "down"; const uA = trace.up.get(e.a), uB = trace.up.get(e.b); if (uB !== undefined && uA === uB + 1) return "up"; return "off"; };

  return (
    <div className="graph-mode">
    <div className="graph-wrap" ref={wrapRef}>
      <svg ref={svgRef} onMouseDown={(e) => onDown(e, null)} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel} style={{ cursor: drag.current && !drag.current.id ? "grabbing" : "default" }}>
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#666" /></marker>
          <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d97757" /></marker>
          <marker id="arrow-cold" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa" /></marker></defs>
        <g ref={gRef} transform={`translate(${size.w / 2 + view.x}, ${size.h / 2 + view.y}) scale(${view.k})`}>
          {/* containment edges */}
          {[...loaded.keys()].filter((id) => id !== cursor).map((id) => { const A = pos.current.get(id), C = pos.current.get(cursor); if (!A || !C) return null; const dim = hi && !hi.has(id) && hover !== id; return <line key={"c" + id} className="g-link" x1={C.x} y1={C.y} x2={A.x} y2={A.y} stroke={id === parentId ? "#6b6b6b" : withAlpha(colorOf(id), 0.55)} strokeWidth={1.2 * inv} opacity={flowMode ? 0.12 : dim ? 0.25 : 1} />; })}
          {/* relation edges between siblings */}
          {relEdges.map((e, i) => { const A = pos.current.get(e.a), B = pos.current.get(e.b); if (!A || !B) return null; const on = hover === e.a || hover === e.b; const dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 1; const x2 = B.x - (dx / d) * 12, y2 = B.y - (dy / d) * 12; // bend in screen px, not layout units: at low zoom a layout-unit bend collapses and parallel edge labels stack
            const away = (-dy / d) * ((A.x + B.x) / 2) + (dx / d) * ((A.y + B.y) / 2) >= 0 ? 1 : -1; const bend = (22 + 16 * Math.floor(i / 2)) * inv * away; const cx = (A.x + B.x) / 2 - (dy / d) * bend, cy = (A.y + B.y) / 2 + (dx / d) * bend; const dpath = `M ${A.x} ${A.y} Q ${cx} ${cy} ${x2} ${y2}`;
            if (!flowMode) return <path key={"r" + i} className="g-link" d={dpath} fill="none" stroke={e.kind === "dep" ? "#d97757" : colorOf(e.a)} strokeDasharray={e.kind === "dep" ? `${5 * inv} ${3 * inv}` : `${2 * inv} ${3 * inv}`} strokeWidth={(on ? 1.8 : 1) * inv} opacity={hover ? (on ? 0.95 : 0.08) : 0.32} markerEnd="url(#arrow)" />;
            const st = flowEdgeState(e); const col = st === "down" ? "#d97757" : st === "up" ? "#60a5fa" : colorOf(e.a); const lit = st === "down" || st === "up";
            // one label per node pair: a second edge between the same two nodes lands its label on top of the first
            const pair = [e.a, e.b].sort().join("|");
            const firstOfPair = relEdges.findIndex((o) => [o.a, o.b].sort().join("|") === pair) === i;
            const showLbl = firstOfPair && (lit || (!traced && relEdges.length <= 12));
            const mx = (A.x + 2 * cx + B.x) / 4, my = (A.y + 2 * cy + B.y) / 4; // point on the quadratic at t=.5
            return <g key={"r" + i}>
              <path className={`g-link g-flow ${lit ? "lit" : ""}`} d={dpath} fill="none" stroke={col} strokeWidth={(lit ? 2.2 : 1.2) * inv} opacity={st === "off" ? 0.06 : lit ? 1 : 0.5} markerEnd={lit ? (st === "down" ? "url(#arrow-hot)" : "url(#arrow-cold)") : "url(#arrow)"} />
              {showLbl && e.via.length > 0 && <text x={mx} y={my - 4 * inv} textAnchor="middle" fontSize={10 * inv} stroke="#000" strokeWidth={3 * inv} paintOrder="stroke" strokeLinejoin="round" fill={lit ? col : "#9a9a9a"} opacity={st === "off" ? 0.1 : 1} style={{ pointerEvents: "none", userSelect: "none" }}>{trunc(e.via[0].split(" → ").pop() ?? e.via[0], 26)}{e.via.length > 1 ? ` +${e.via.length - 1}` : ""}</text>}
            </g>; })}
          {[...loaded].map(([id, n]) => {
            const P = pos.current.get(id); if (!P) return null;
            const isCursor = id === cursor, isParent = id === parentId, isSel = id === selected, isIntent = !n || n.kind === "intent";
            const kids = Object.values(nodes).filter((x) => x.parent === (id === ROOT ? null : id)).length;
            const r = isCursor ? 17 : isParent ? 11 : isIntent ? 13 : 10;
            const col = colorOf(id); const ring = n ? STATUS_RING[n.status] : undefined;
            const title = id === ROOT ? "app" : n!.title;
            const dim = hi && !hi.has(id) && hover !== id && !isCursor && !isParent;
            const flowDim = flowMode && !traced && !isCursor && !isParent && !relEdges.some((e) => e.a === id || e.b === id);
            // the cursor and the way back up sit alone in the middle — they can afford the full label
            const roomy = isCursor || isParent;
            const lines = labelLines(title, roomy ? LABEL_CHARS : lblChars, roomy ? LABEL_LINES : lblLines);
            const lp = labelPos(P, r, view.k, isCursor || isParent, lines.length);
            return (
              <g key={id} className="g-node" data-node={id} transform={`translate(${P.x},${P.y})`} opacity={dim ? 0.35 : flowDim ? 0.45 : isParent ? 0.8 : 1} onMouseDown={(e) => onDown(e, id)} onClick={() => click(id)} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)}>
                {/* everything inside is in CSS px: a node and its label read the same at any zoom or screen size */}
                <g transform={`scale(${inv})`}>
                  <circle className="halo" r={r + 12} fill={col} />
                  <circle r={r} fill={isIntent ? "#0a0a0a" : col} stroke={isSel ? "#fff" : col} strokeWidth={isSel ? 2.5 : isIntent ? 1.8 : 1.2} strokeDasharray={n?.status === "proposed" ? "3 2" : undefined} />
                  {ring && <circle r={r + 4} fill="none" stroke={ring} strokeWidth={1.5} opacity={0.9} />}
                  {isIntent && kids > 0 && <text textAnchor="middle" dy="3.5" fontSize={10} fill={col} style={{ pointerEvents: "none" }}>{kids}</text>}
                  {isParent && <text textAnchor="middle" y={-r - 7} fontSize={10} fill="#8a8a8a" style={{ pointerEvents: "none" }}>▲ up</text>}
                  {flowMode && traced && id !== cursor && id !== parentId && (() => { const dn = trace.down.get(id), upn = trace.up.get(id); if (dn === undefined && upn === undefined) return null; const lbl = id === traced ? "●" : dn !== undefined ? `+${dn}` : `−${upn}`; const c = id === traced ? "#fff" : dn !== undefined ? "#d97757" : "#60a5fa"; return <g transform={`translate(${r + 2},${-r - 2})`} style={{ pointerEvents: "none" }}><circle r={7} fill="#0a0a0a" stroke={c} strokeWidth={1} /><text textAnchor="middle" dy="3" fontSize={8} fill={c}>{lbl}</text></g>; })()}
                  {(!labelHidden.has(id) || isSel || isCursor || hover === id) && lines.map((ln, li) => (
                    <text key={li} className="lbl" textAnchor={lp.anchor} x={lp.x} y={lp.y + li * LABEL_LINE + (labelShift[id] ?? 0)} fontSize={isCursor ? LABEL_PX + 1.5 : LABEL_PX} fontWeight={isCursor || isSel ? 700 : 400} fill={isSel || isCursor ? "#fff" : "#e5e5e5"} style={{ userSelect: "none" }}>{ln}</text>
                  ))}
                  {n?.staged && <text textAnchor={lp.anchor} x={lp.x} y={lp.y + lines.length * LABEL_LINE + (labelShift[id] ?? 0)} fontSize={10} fill="#d97757">staged</text>}
                </g>
              </g>);
          })}
        </g>
      </svg>

    </div>
    {/* in normal flow under the canvas, not floating over it — an overlay is a label collision waiting to happen */}
    <div className="graph-toolbar">
        <span className="breadcrumb" style={{ margin: 0 }}>{crumbs.map((c, i) => <span key={c.id ?? "root"} className={i === crumbs.length - 1 ? "here" : ""} onClick={() => navigate(c.id)}>{trunc(c.title, 22)}{i < crumbs.length - 1 ? " ▸ " : ""}</span>)}</span>
        <span className="dim">· {children.length} loaded</span>
        <span style={{ width: 8 }} />
        <button className={layout === "force" ? "primary" : ""} onClick={() => { setLayout("force"); try { localStorage.setItem("lg.graphLayout", "force"); } catch {} }}>force</button>
        <button className={layout === "tree" ? "primary" : ""} onClick={() => { setLayout("tree"); try { localStorage.setItem("lg.graphLayout", "tree"); } catch {} }}>tree</button>
        <button className={flowMode ? "primary" : ""} onClick={toggleFlow} title="flow mode: show call direction between the loaded nodes and trace downstream (orange) / upstream (blue) from the selected or hovered node">flow</button>
        <button onClick={() => { pos.current.clear(); setSeed((s) => s + 1); }}>re-sort</button>
        <button onClick={() => fitAll(false, true)}>fit</button>
        {onCards && <button onClick={onCards} title="switch to the card list">cards</button>}
        <span style={{ width: 8 }} />
        <button className={generated ? "" : "primary"} disabled={!!deriving} onClick={deriveGraph} title={generated ? "re-derive the graph from code (choose what to replace)" : "derive intent/behavior nodes from the code, one LLM call per folder"}>{deriving ? `generating ${deriving.done}/${deriving.total || "?"}…` : generated ? "regenerate graph" : "generate graph"}</button>
        <span className="graph-hint">{flowMode ? "arrows = calls · hover to trace · +n downstream · −n upstream" : "click intent: go there · click behavior: details · drag: pan · wheel: zoom"}</span>
      </div>
    </div>
  );
}

/** Labels go outward from the cursor (which sits at the origin): left nodes read leftward, right nodes rightward.
 *  Offsets are CSS px (the label lives inside the node's scale(1/k) group); `k` converts the position to px. */
function labelPos(P: { x: number; y: number }, r: number, k: number, centered: boolean, lines: number): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  const px = P.x * k;
  if (centered || (Math.abs(px) < 18 && P.y >= 0)) return { x: 0, y: r + LABEL_LINE, anchor: "middle" };
  if (Math.abs(px) < 18) return { x: 0, y: -r - 8 - (lines - 1) * LABEL_LINE, anchor: "middle" };
  const dy = 4 - ((lines - 1) * LABEL_LINE) / 2;
  return px < 0 ? { x: -r - LABEL_GAP, y: dy, anchor: "end" } : { x: r + LABEL_GAP, y: dy, anchor: "start" };
}
function trunc(s: string, n: number) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
