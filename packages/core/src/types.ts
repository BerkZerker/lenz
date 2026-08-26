import type { Anchor } from "@lenzgraph/structure";

export type NodeKind = "intent" | "behavior";
export type NodeStatus = "proposed" | "specified" | "building" | "built" | "verified" | "rejected" | "drifted";
export type ExpectMode = "exit0" | "stdout_equals" | "stdout_contains" | "json_subset" | "manual";

export interface Example {
  id: string;
  name: string;
  given?: string;
  when?: string;
  then?: string;
  run?: string;
  expect?: { mode: ExpectMode; value?: any };
  derived?: boolean;
}

export interface ExampleResult { id: string; pass: boolean | null; actual: string; exit: number | null; at: string; note?: string }

export interface Verification {
  examples?: { pass: number; fail: number; pending: number; at: string; results: ExampleResult[] };
  machine?: { ok: boolean; exit: number; tail: string; at: string };
  reconstruction?: { verdict: "match" | "mismatch" | "error"; reasons: string[]; at: string };
  approved_by?: string;
  approved_at?: string;
  rejection_note?: string;
}

export interface ProposedAnchor extends Anchor { change: "added" | "changed" | "removed"; owner?: string | null }

export interface LenzNode {
  id: string;
  kind: NodeKind;
  title: string;
  parent: string | null;
  deps: string[];
  status: NodeStatus;
  spec: string;
  examples?: Example[];
  anchors?: Anchor[];
  machine?: { run: string };
  verification?: Verification;
  reconstruction?: string; // living docs
  staged?: boolean;
  needs_reverify?: boolean;
  prev_status?: NodeStatus; // for drifted
  drift?: { reasons: string[]; at: string };
  proposed_anchors?: ProposedAnchor[];
  last_run?: string;
  derived?: boolean;
  pinned_entry?: string[];
}

/** Fields a client may PUT. Everything else is owned by core. */
export const EDITABLE_FIELDS = ["title", "spec", "examples", "deps", "machine", "parent", "kind"] as const;

export type RunKind = "build" | "propose" | "derive" | "reconstruct" | "compare";
export type RunStatus = "queued" | "running" | "done" | "failed" | "killed" | "timeout";

export interface RunRecord {
  id: string;
  kind: RunKind;
  node: string | null;
  status: RunStatus;
  started_at?: string;
  ended_at?: string;
  exit?: number | null;
  duration?: number;
  session_id?: string;
  changed_symbols?: string[];
  locks_held?: string[];
  note?: string;
  error?: string;
  result_text?: string;
  cost_usd?: number;
  provider?: string;
  tokens?: { prompt: number; output: number; thoughts?: number };
}

export interface Lock { file: string; run: string; acquired_at: number; last_write_at: number }
export interface LockEvent { at: string; kind: "grant" | "deny" | "transfer" | "release" | "expire"; file: string; run: string; from?: string; reason?: string }
