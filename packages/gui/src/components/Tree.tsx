import { useMemo } from "react";
import { useStore } from "../store";
import type { TreeItem } from "../types";
import { Dot } from "./common";

export function Tree() {
  const { tree, focus, selected, search, setFocus, setSelected, setSearch, nodes } = useStore();
  const ego = useMemo(() => {
    // ego-neighborhood: focus, its ancestors, its children, and selected's siblings
    const set = new Set<string>();
    const add = (id: string | null) => { let n = id ? nodes[id] : null; while (n) { set.add(n.id); n = n.parent ? nodes[n.parent] : null; } };
    add(focus); add(selected);
    for (const n of Object.values(nodes)) if (n.parent === focus || n.parent === (selected ? nodes[selected]?.parent : null)) set.add(n.id);
    return set;
  }, [focus, selected, nodes]);
  const q = search.toLowerCase();
  const render = (items: TreeItem[], depth: number): React.ReactNode => items.map((t) => {
    const match = !q || t.title.toLowerCase().includes(q) || t.id.includes(q);
    const kids = render(t.children, depth + 1);
    if (q && !match && !(t.children.length && hasMatch(t, q))) return null;
    return (
      <div key={t.id}>
        <div className={`tree-item ${ego.has(t.id) || q ? "" : "dimmed"} ${t.id === focus ? "focused" : ""} ${t.id === selected ? "selected" : ""}`} style={{ paddingLeft: 4 + depth * 12 }}
          onClick={() => { setSelected(t.id); if (t.kind === "intent") setFocus(t.id); else setFocus(t.id === focus ? t.id : nodes[t.id]?.parent ?? null); }} title={t.id}>
          {t.id === focus ? <span className="accent">▸ </span> : t.kind === "intent" ? <span className="dim">▸ </span> : "  "}
          <Dot n={t} />{t.title}{t.staged ? <span className="accent"> ·s</span> : ""}{t.needs_reverify ? <span className="warn"> ·r</span> : ""}
        </div>
        {kids}
      </div>
    );
  });
  return (
    <div className="pane">
      <div className="pane-header"><span>tree</span><span>{Object.keys(nodes).length}</span></div>
      <div className="pane-body">
        <input className="search" id="tree-search" placeholder="/ search" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <div className={`tree-item ${focus === null ? "focused" : ""}`} onClick={() => { setFocus(null); setSelected(null); }}><span className="accent">{focus === null ? "▸ " : "  "}</span>app</div>
        {render(tree, 1)}
        {!tree.length && <div className="hint">no nodes yet. press <span className="kbd">7</span> to propose from a brain-dump, or run <code>lenzgraph derive</code> on existing code.</div>}
      </div>
    </div>
  );
}
function hasMatch(t: TreeItem, q: string): boolean { return t.children.some((c) => c.title.toLowerCase().includes(q) || hasMatch(c, q)); }
