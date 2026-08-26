import { api } from "./api";
import { useStore } from "./store";
import type { DeriveReset, LenzNode } from "./types";

const RESET_OPTIONS = [
  { value: "proposed", label: "replace unreviewed nodes only", hint: "derived nodes still `proposed` are dropped and re-derived; approved ones stay" },
  { value: "all", label: "replace ALL derived nodes", hint: "every node marked `derived` is dropped, approved or not; hand-written nodes stay" },
];
const post = (path: string, reset: DeriveReset) => api(path, { reset }).then((r) => useStore.getState().notify(r.started ? `deriving ${r.scope}…` : `regenerated ${r.title}`)).catch((e) => useStore.getState().notify(e.message));

/** Whole graph: first run derives straight away; later runs ask which derived nodes to replace. */
export function deriveGraph() {
  const s = useStore.getState();
  if (s.status?.deriving) return s.notify(`already deriving ${s.status.deriving.scope}`);
  const generated = Object.values(s.nodes).some((n) => n.derived);
  if (!generated) return void post("/derive", "none");
  s.openModal({ kind: "choice", title: "regenerate graph from code", initial: "proposed", options: RESET_OPTIONS, onSubmit: (reset) => post("/derive", reset as DeriveReset) });
}
/** One node: intents re-derive their folder subtree (asks what to replace), behaviors rewrite spec/examples from their anchors. */
export function deriveNode(n: LenzNode) {
  const s = useStore.getState();
  if (s.status?.deriving) return s.notify(`already deriving ${s.status.deriving.scope}`);
  if (n.kind === "behavior") return s.openModal({ kind: "confirm", title: `rewrite "${n.title}" spec + examples from its ${(n.anchors ?? []).length} symbols? (anchors kept)`, onSubmit: () => post(`/nodes/${n.id}/derive`, "none") });
  s.openModal({ kind: "choice", title: `regenerate "${n.title}" from ${n.folder !== undefined ? `folder ${n.folder || "."}` : "its code"}`, initial: "proposed", options: RESET_OPTIONS, onSubmit: (reset) => post(`/nodes/${n.id}/derive`, reset as DeriveReset) });
}
