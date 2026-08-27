import { create } from "zustand";
import { api } from "./api";
import type { Lens, LenzNode, Lock, LockEvent, RunRecord, Status, TreeItem } from "./types";

export interface RunEvent { run: string; node: string | null; kind: string; event: any; at: string }
export interface Modal { kind: "text" | "yaml" | "help" | "confirm" | "choice"; title: string; initial?: string; placeholder?: string; options?: { value: string; label: string; hint?: string }[]; onSubmit?: (v: string) => void }

interface State {
  nodes: Record<string, LenzNode>; tree: TreeItem[]; status: Status | null; runs: RunRecord[]; locks: Lock[]; lockLog: LockEvent[];
  runEvents: RunEvent[]; logs: { at: string; level: string; msg: string }[]; connected: boolean;
  relations: Record<string, { out: { id: string; via: string[] }[]; in: { id: string; via: string[] }[] }>;
  lens: Lens; focus: string | null; selected: string | null; search: string; modal: Modal | null; toast: string | null;
  treeMode: "nodes" | "files"; expanded: Set<string>; flowFrom: string | null;
  /** a file (and optionally a symbol in it) chosen in the file tree — drives the code view */
  picked: { file: string; key?: string } | null; setPicked: (p: { file: string; key?: string } | null) => void;
  setTreeMode: (m: "nodes" | "files") => void; toggleExpanded: (id: string) => void; setExpanded: (ids: Iterable<string>) => void; setFlowFrom: (k: string | null) => void;
  setLens: (l: Lens) => void; setFocus: (id: string | null) => void; setSelected: (id: string | null) => void; setSearch: (s: string) => void;
  openModal: (m: Modal | null) => void; notify: (s: string) => void;
  refresh: () => Promise<void>; refreshRuns: () => Promise<void>;
  connect: () => void;
}

export const useStore = create<State>((set, get) => ({
  nodes: {}, tree: [], status: null, runs: [], locks: [], lockLog: [], runEvents: [], logs: [], connected: false, relations: {},
  lens: "graph", focus: null, selected: null, search: "", modal: null, toast: null,
  treeMode: (() => { try { return localStorage.getItem("lg.treeMode") === "files" ? "files" : "nodes"; } catch { return "nodes"; } })(), expanded: new Set<string>(), flowFrom: null,
  picked: null,
  // picking a file and selecting a node are the two things the right pane can show, so one clears the other
  setPicked: (picked) => set({ picked, ...(picked ? { selected: null } : {}) }),
  setTreeMode: (treeMode) => { try { localStorage.setItem("lg.treeMode", treeMode); } catch {} set({ treeMode }); },
  toggleExpanded: (id) => set((s) => { const expanded = new Set(s.expanded); expanded.has(id) ? expanded.delete(id) : expanded.add(id); return { expanded }; }),
  setExpanded: (ids) => set({ expanded: new Set(ids) }),
  setFlowFrom: (flowFrom) => set({ flowFrom }),
  setLens: (lens) => set({ lens }),
  // focusing/selecting reveals the node in the tree (expands its ancestors), like VS Code's reveal-in-explorer
  setFocus: (focus) => set((s) => ({ focus, expanded: reveal(s, focus, true) })),
  setSelected: (selected) => set((s) => ({ selected, picked: selected ? null : s.picked, expanded: reveal(s, selected, false) })),
  setSearch: (search) => set({ search }),
  openModal: (modal) => set({ modal }),
  notify: (toast) => { set({ toast }); setTimeout(() => set((s) => (s.toast === toast ? { toast: null } : {})), 3000); },
  refresh: async () => {
    const [nodes, tree, status, relations] = await Promise.all([api<LenzNode[]>("/nodes"), api<TreeItem[]>("/tree"), api<Status>("/status"), api("/relations").catch(() => ({}))]);
    set({ nodes: Object.fromEntries(nodes.map((n) => [n.id, n])), tree, status, relations });
  },
  refreshRuns: async () => {
    const [runs, l] = await Promise.all([api<RunRecord[]>("/runs"), api<{ locks: Lock[]; log: LockEvent[] }>("/locks")]);
    set({ runs, locks: l.locks, lockLog: l.log });
  },
  connect: () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/events`);
    ws.onopen = () => { set({ connected: true }); void get().refresh(); void get().refreshRuns(); };
    ws.onclose = () => { set({ connected: false }); setTimeout(() => get().connect(), 1500); };
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      const s = get();
      switch (ev.type) {
        case "node.updated": { set({ nodes: { ...s.nodes, [ev.data.id]: ev.data.node } }); void api<TreeItem[]>("/tree").then((tree) => set({ tree })); void api<Status>("/status").then((status) => set({ status })); break; }
        case "node.deleted": { const n = { ...s.nodes }; delete n[ev.data.id]; set({ nodes: n, selected: s.selected === ev.data.id ? null : s.selected }); void api<TreeItem[]>("/tree").then((tree) => set({ tree })); break; }
        case "run.updated": { const runs = s.runs.filter((r) => r.id !== ev.data.run.id); runs.unshift(ev.data.run); set({ runs }); void api<Status>("/status").then((status) => set({ status })); break; }
        case "run.event": { if (ev.data.event) set({ runEvents: [...s.runEvents.slice(-1500), { ...ev.data, at: ev.at }] }); break; }
        case "lock.changed": { set({ locks: ev.data.locks, lockLog: [...s.lockLog.slice(-300), ev.data.event] }); void api<Status>("/status").then((status) => set({ status })); break; }
        case "drift.detected": { s.notify(`drift: ${ev.data.id} — ${ev.data.reasons.join("; ")}`); break; }
        case "structure.synced": { void api<Status>("/status").then((status) => set({ status })); void api("/relations").then((relations) => set({ relations })).catch(() => {}); break; }
        case "derive.progress": { if (s.status) set({ status: { ...s.status, deriving: ev.data } }); if (ev.data === null) void get().refresh(); break; }
        case "staging.changed": { void api<Status>("/status").then((status) => set({ status })); break; }
        case "log": { set({ logs: [...s.logs.slice(-300), { at: ev.at, ...ev.data }] }); break; }
      }
    };
  },
}));

function reveal(s: State, id: string | null, self: boolean): Set<string> {
  if (!id) return s.expanded;
  const ex = new Set(s.expanded);
  let n = self ? s.nodes[id] : (s.nodes[id]?.parent ? s.nodes[s.nodes[id].parent!] : null);
  while (n) { ex.add(n.id); n = n.parent ? s.nodes[n.parent] : null; }
  return ex;
}
