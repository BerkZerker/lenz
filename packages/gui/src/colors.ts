import type { LenzNode } from "./types";

/** One hue per top-level subtree ("area"), assigned by sorted title so it is stable across reloads. */
export const PALETTE = ["#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#22d3ee", "#fb923c", "#a3e635", "#f87171", "#e879f9", "#2dd4bf", "#facc15"];
export const STATUS_RING: Record<string, string> = { building: "#3b82f6", built: "#eab308", verified: "#22c55e", rejected: "#ef4444", drifted: "#ef4444" };

export function areaOf(nodes: Record<string, LenzNode>, id: string | null): string | null {
  let n = id ? nodes[id] : null; if (!n) return null;
  while (n.parent && nodes[n.parent]) n = nodes[n.parent];
  return n.id;
}
export function areaIndex(nodes: Record<string, LenzNode>, areaId: string): number {
  const tops = Object.values(nodes).filter((n) => !n.parent).sort((a, b) => a.title.localeCompare(b.title));
  const i = tops.findIndex((t) => t.id === areaId);
  return i < 0 ? 0 : i;
}
export function areaColor(nodes: Record<string, LenzNode>, id: string | null): string {
  const a = areaOf(nodes, id); if (!a) return "#d4d4d4";
  return PALETTE[areaIndex(nodes, a) % PALETTE.length];
}
export function withAlpha(hex: string, a: number) { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
