import { useEffect, useRef } from "react";
import YAML from "yaml";
import { api } from "./api";
import { useStore } from "./store";
import { Tree } from "./components/Tree";
import { Inspector } from "./components/Inspector";
import { StatusBar } from "./components/StatusBar";
import { Modal } from "./components/Modal";
import { GraphLens } from "./lenses/Graph";
import { QueueLens } from "./lenses/Queue";
import { VerifyLens } from "./lenses/Verify";
import { OrphansLens } from "./lenses/Orphans";
import { RunsLens } from "./lenses/Runs";
import { FlowLens } from "./lenses/Flow";
import { ProposeLens } from "./lenses/Propose";
import { StageLens } from "./lenses/Stage";
import type { Lens } from "./types";
import { deriveGraph } from "./derive";

const LENSES: { id: Lens; key: string; title: string; q: string }[] = [
  { id: "graph", key: "1", title: "graph", q: "what is this?" }, { id: "queue", key: "2", title: "queue", q: "what's next?" }, { id: "verify", key: "3", title: "verify", q: "what needs my judgment?" },
  { id: "orphans", key: "4", title: "orphans", q: "what code has no owner?" }, { id: "runs", key: "5", title: "runs", q: "what are agents doing?" }, { id: "flow", key: "6", title: "flow", q: "how does this execute?" },
  { id: "propose", key: "7", title: "propose", q: "greenfield input" }, { id: "stage", key: "8", title: "stage", q: "staged set + blast radius" },
];

export function App() {
  const { lens, setLens, connect } = useStore();
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    connect();
    // #<lens>[/<node id>] — the node id sets the graph cursor (deep link to a location)
    const fromHash = () => { const [h, id] = location.hash.replace("#", "").split("?")[0].split("/") as [Lens, string?]; const fm = /[?&]from=([^&]+)/.exec(location.hash); if (fm) useStore.getState().setFlowFrom(decodeURIComponent(fm[1])); if (LENSES.some((l) => l.id === h)) setLens(h); if (id && id.startsWith("n_")) pendingFocus.current = id; applyPending(); };
    const applyPending = () => { const id = pendingFocus.current; if (!id) return; const s = useStore.getState(); const n = s.nodes[id]; if (!n) return; pendingFocus.current = null; if (n.kind === "intent") { s.setFocus(id); s.setSelected(id); } else { s.setFocus(n.parent); s.setSelected(id); } };
    fromHash(); window.addEventListener("hashchange", fromHash);
    const unsub = useStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) applyPending(); });
    return () => { window.removeEventListener("hashchange", fromHash); unsub(); };
  }, []);
  const focus = useStore((s) => s.focus);
  useEffect(() => { const want = "#" + lens + (lens === "graph" && focus ? "/" + focus : ""); if (location.hash.split("?")[0] !== want) history.replaceState(null, "", want); }, [lens, focus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const s = useStore.getState();
      if (s.modal) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) { if (e.key === "Escape") t.blur(); return; }
      const sel = s.selected ? s.nodes[s.selected] : null;
      const visible = visibleIds(s);
      const idx = s.selected ? visible.indexOf(s.selected) : -1;
      const go = (i: number) => { if (visible.length) s.setSelected(visible[Math.max(0, Math.min(visible.length - 1, i))]); };
      const L = LENSES.find((l) => l.key === e.key);
      if (L) return setLens(L.id);
      switch (e.key) {
        case "j": case "ArrowDown": e.preventDefault(); return go(idx + 1);
        case "k": case "ArrowUp": e.preventDefault(); return go(idx - 1);
        case "Enter": if (sel && sel.kind === "intent") { s.setFocus(sel.id); s.setSelected(null); } return;
        case "Escape": case "h": { if (s.selected) return s.setSelected(null); const f = s.focus ? s.nodes[s.focus] : null; s.setFocus(f?.parent ?? null); s.setSelected(f?.id ?? null); return; }
        case "/": e.preventDefault(); return (document.getElementById("tree-search") as HTMLInputElement)?.focus();
        case "?": return s.openModal({ kind: "help", title: "keys" });
        case "a": if (sel) act(`/nodes/${sel.id}/approve`, {}); return;
        case "r": if (sel) return s.openModal({ kind: "text", title: `reject ${sel.title}`, placeholder: "what is wrong? (sent to the agent on re-dispatch)", onSubmit: (note) => act(`/nodes/${sel.id}/reject`, { note }) });
          return;
        case "d": if (sel) act(`/nodes/${sel.id}/dispatch`, {}); return;
        case "e": { const n = sel ?? (s.focus ? s.nodes[s.focus] : null); if (!n) return;
          const editable = { title: n.title, kind: n.kind, parent: n.parent, deps: n.deps, spec: n.spec, ...(n.kind === "behavior" ? { examples: (n.examples ?? []).map((x) => ({ ...x })), machine: n.machine ?? null } : {}) };
          return s.openModal({ kind: "yaml", title: `edit ${n.id} (yaml; spec/example changes stage the node)`, initial: YAML.stringify(editable), onSubmit: (text) => { try { const patch = YAML.parse(text); if (patch.machine === null) delete patch.machine; act(`/nodes/${n.id}`, patch, "PUT"); } catch (err: any) { s.notify(`yaml error: ${err.message}`); } } }); }
        case "n": { const parent = s.focus; return s.openModal({ kind: "yaml", title: `new node under ${parent ? s.nodes[parent]?.title : "root"}`, initial: YAML.stringify({ kind: "behavior", title: "", spec: "", examples: [{ name: "happy path", given: "", when: "", then: "" }] }), onSubmit: (text) => { try { act("/nodes", { ...YAML.parse(text), parent, status: "specified" }); } catch (err: any) { s.notify(`yaml error: ${err.message}`); } } }); }
        case "x": if (sel) return s.openModal({ kind: "confirm", title: `delete ${sel.title} and its children?`, onSubmit: () => act(`/nodes/${sel.id}`, undefined, "DELETE") }); return;
        case "c": return act("/staging/confirm", {});
        case "i": return act("/staging/immediate", { on: !s.status?.staged.immediate });
        case "g": return deriveGraph();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const cur = LENSES.find((l) => l.id === lens)!;
  return (
    <div className="app">
      <div className="panes">
        <Tree />
        <div className="pane">
          <div className="pane-header"><span>{LENSES.map((l) => <span key={l.id} className={l.id === lens ? "accent" : "link"} style={{ marginRight: 12, cursor: "pointer" }} onClick={() => setLens(l.id)}>{l.key} {l.title}</span>)}</span><span>{cur.q}</span></div>
          <div className="pane-body">
            {lens === "graph" && <GraphLens />}{lens === "queue" && <QueueLens />}{lens === "verify" && <VerifyLens />}{lens === "orphans" && <OrphansLens />}
            {lens === "runs" && <RunsLens />}{lens === "flow" && <FlowLens />}{lens === "propose" && <ProposeLens />}{lens === "stage" && <StageLens />}
          </div>
        </div>
        <Inspector />
      </div>
      <StatusBar />
      <Modal />
    </div>
  );
}

function act(path: string, body?: any, method?: string) {
  api(path, body, method).catch((e) => useStore.getState().notify(e.message));
}
/** ids navigable with j/k in the current lens, in display order */
function visibleIds(s: ReturnType<typeof useStore.getState>): string[] {
  const all = Object.values(s.nodes);
  const byTitle = (a: any, b: any) => a.title.localeCompare(b.title);
  switch (s.lens) {
    case "graph": return all.filter((n) => n.parent === s.focus).sort(byTitle).map((n) => n.id);
    case "queue": return all.filter((n) => n.kind === "behavior" && (n.status === "specified" || n.status === "rejected")).sort(byTitle).map((n) => n.id);
    case "verify": return all.filter((n) => n.status === "built" || n.status === "drifted" || (n.status === "verified" && n.needs_reverify)).sort((a, b) => a.status.localeCompare(b.status) || byTitle(a, b)).map((n) => n.id);
    case "propose": return all.filter((n) => n.status === "proposed").sort(byTitle).map((n) => n.id);
    case "stage": return [...(s.status?.staged.staged ?? []), ...(s.status?.staged.blast ?? [])];
    default: { const flat: string[] = []; const walk = (items: any[]) => { for (const t of items) { flat.push(t.id); walk(t.children); } }; walk(s.tree); return flat; }
  }
}
