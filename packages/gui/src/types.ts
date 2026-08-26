export interface Anchor { kind: string; name: string; container: string; file: string; sig: string; body: string }
export interface Example { id: string; name: string; given?: string; when?: string; then?: string; run?: string; expect?: { mode: string; value?: any }; derived?: boolean }
export interface ExampleResult { id: string; pass: boolean | null; actual: string; exit: number | null; at: string; note?: string }
export interface LenzNode {
  id: string; kind: "intent" | "behavior"; title: string; parent: string | null; deps: string[]; status: string; spec: string;
  examples?: Example[]; anchors?: Anchor[]; machine?: { run: string };
  verification?: { examples?: { pass: number; fail: number; pending: number; at: string; results: ExampleResult[] }; machine?: { ok: boolean; exit: number; tail: string; at: string }; reconstruction?: { verdict: string; reasons: string[]; at: string }; approved_by?: string; approved_at?: string; rejection_note?: string };
  reconstruction?: string; staged?: boolean; needs_reverify?: boolean; prev_status?: string; drift?: { reasons: string[]; at: string };
  proposed_anchors?: (Anchor & { change: string; owner?: string | null })[]; last_run?: string; derived?: boolean;
}
export interface TreeItem { id: string; kind: string; title: string; status: string; staged: boolean; needs_reverify: boolean; children: TreeItem[] }
export interface RunRecord { id: string; kind: string; node: string | null; status: string; started_at?: string; ended_at?: string; exit?: number | null; duration?: number; session_id?: string; changed_symbols?: string[]; locks_held?: string[]; note?: string; error?: string; result_text?: string; cost_usd?: number }
export interface Lock { file: string; run: string; acquired_at: number; last_write_at: number }
export interface LockEvent { at: string; kind: string; file: string; run: string; from?: string; reason?: string }
export interface SymbolRow { key: string; kind: string; name: string; container: string; file: string; start_line: number; end_line: number; exported: number }
export interface Status { runs: number; locks: number; drifted: number; staged: { staged: string[]; blast: string[]; immediate: boolean }; orphans: number; nodes: number }
export type Lens = "graph" | "queue" | "verify" | "orphans" | "runs" | "flow" | "propose" | "stage";
