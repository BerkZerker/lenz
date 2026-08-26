import type { LenzNode } from "../types";
import { areaColor, STATUS_RING } from "../colors";
import { useStore } from "../store";
export const StatusTag = ({ status }: { status: string }) => <span className={`tag status-${status}`}>{status}</span>;
export const Dot = ({ n }: { n: { id?: string; kind: string; status: string } }) => {
  const nodes = useStore((s) => s.nodes);
  const col = n.id ? areaColor(nodes, n.id) : "#737373";
  const ring = STATUS_RING[n.status];
  return <span className="dot" style={{ background: n.kind === "intent" ? "transparent" : col, border: `1px ${n.status === "proposed" ? "dashed" : "solid"} ${col}`, boxShadow: ring ? `0 0 0 1px #000, 0 0 0 2px ${ring}` : undefined }} title={n.status} />;
};
export function NodeCard({ n, selected, onClick, extra }: { n: LenzNode; selected: boolean; onClick: () => void; extra?: React.ReactNode }) {
  return (
    <div className={`card ${selected ? "selected" : ""} ${n.status === "proposed" ? "proposed" : ""}`} onClick={onClick} data-id={n.id}>
      <div className="title"><span><Dot n={n} />{n.title}</span><StatusTag status={n.status} /></div>
      <div className="spec">{n.spec || <span className="dim">(no spec)</span>}</div>
      <div className="meta">
        <span>{n.kind}</span>
        {n.kind === "behavior" && <span>{(n.examples ?? []).length} ex · {(n.anchors ?? []).length} sym</span>}
        {n.staged && <span className="accent">staged</span>}
        {n.needs_reverify && <span className="warn">needs-reverify</span>}
        {n.derived && <span className="dim">derived</span>}
        {extra}
      </div>
    </div>
  );
}
export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : "");
export const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
