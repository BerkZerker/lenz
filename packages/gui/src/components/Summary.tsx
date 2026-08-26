import { useStore } from "../store";
import { areaColor } from "../colors";

/** Renders a summary with [[node_id]] links: colored by area, click navigates. */
export function Summary({ text, className }: { text: string; className?: string }) {
  const { nodes, setFocus, setSelected } = useStore();
  const parts = text.split(/(\[\[n_[a-z0-9]+\]\])/g);
  return (
    <span className={className}>
      {parts.map((p, i) => {
        const m = p.match(/^\[\[(n_[a-z0-9]+)\]\]$/);
        if (!m) return <span key={i}>{p}</span>;
        const n = nodes[m[1]];
        if (!n) return <span key={i} className="dim">{m[1]}</span>;
        return <a key={i} href={"#" + n.id} className="nodelink" style={{ color: areaColor(nodes, n.id), borderBottomColor: areaColor(nodes, n.id) }} title={n.spec.slice(0, 200)}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (n.kind === "intent") { setFocus(n.id); setSelected(n.id); } else { setFocus(n.parent); setSelected(n.id); } }}>{n.title}</a>;
      })}
    </span>
  );
}
