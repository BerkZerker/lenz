import { useEffect, useState } from "react";
import { api } from "../../api";
import { useStore } from "../../store";
import type { SymbolRow } from "../../types";

export function OrphansLens() {
  const { nodes, status } = useStore();
  const [data, setData] = useState<{ total_symbols: number; orphan_count: number; files: { file: string; symbols: SymbolRow[] }[] } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const load = () => api("/orphans").then(setData);
  useEffect(() => { void load(); }, [status?.orphans, Object.keys(nodes).length]);
  const behaviors = Object.values(nodes).filter((n) => n.kind === "behavior").sort((a, b) => a.title.localeCompare(b.title));
  const assign = async (key: string, owner: string) => { if (!owner) return; await api(`/nodes/${owner}/anchors/assign`, { key, owner }); void load(); };
  if (!data) return <div className="dim">loading…</div>;
  const pct = data.total_symbols ? Math.round((100 * (data.total_symbols - data.orphan_count)) / data.total_symbols) : 100;
  return (
    <>
      <div className="section"><div className="section-h">orphans — {data.orphan_count} of {data.total_symbols} symbols have no owner ({pct}% owned)</div>
        <div className="dim">greenfield: an orphan is something nobody asked for · brownfield: burn this down with generate graph (g) + assignment</div></div>
      {data.files.map((f) => (
        <div className="orphan-file" key={f.file}><div className="fname">{f.file}</div>
          {f.symbols.map((s) => (
            <div key={s.key} className={`orphan-sym ${sel === s.key ? "selected" : ""}`} onClick={() => setSel(s.key)}>
              <span className="dim">{s.kind}</span><span>{s.container ? s.container + "." : ""}{s.name}</span><span className="dim">L{s.start_line}</span>
              <select value="" onChange={(e) => assign(s.key, e.target.value)}><option value="">assign to…</option>{behaviors.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select>
            </div>
          ))}
        </div>
      ))}
      {!data.files.length && <div className="hint">no orphans. every symbol is owned by a behavior node.</div>}
    </>
  );
}
