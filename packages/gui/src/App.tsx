import { useEffect } from "react";
import YAML from "yaml";
import { api } from "./api";
import { useStore } from "./store";
import { Tree } from "./components/Tree";
import { Detail } from "./components/Detail";
import { StatusBar } from "./components/StatusBar";
import { Modal } from "./components/Modal";
import { deriveGraph } from "./derive";

/**
 * Two panes: the tree on the left (nodes or files), whatever it selected on the right (a node's description, or a
 * file's source). The lens views this app used to carry are shelved under src/vault.
 */
export function App() {
  const connect = useStore((s) => s.connect);
  useEffect(() => {
    connect();
    // #<node id> deep-links straight to a node
    const fromHash = () => {
      const id = location.hash.replace(/^#\/?/, "").split("?")[0];
      if (!id.startsWith("n_")) return;
      const s = useStore.getState(); const n = s.nodes[id];
      if (!n) return;
      if (n.kind === "intent") { s.setFocus(id); s.setSelected(id); } else { s.setFocus(n.parent); s.setSelected(id); }
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    const unsub = useStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes) fromHash(); });
    return () => { window.removeEventListener("hashchange", fromHash); unsub(); };
  }, []);

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
      switch (e.key) {
        case "j": case "ArrowDown": e.preventDefault(); return go(idx + 1);
        case "k": case "ArrowUp": e.preventDefault(); return go(idx - 1);
        case "Enter": if (sel && sel.kind === "intent") { s.setFocus(sel.id); } return;
        case "Escape": case "h": { if (s.picked) return s.setPicked(null); if (s.selected) return s.setSelected(null); const f = s.focus ? s.nodes[s.focus] : null; s.setFocus(f?.parent ?? null); s.setSelected(f?.id ?? null); return; }
        case "t": return s.setTreeMode(s.treeMode === "nodes" ? "files" : "nodes");
        case "/": e.preventDefault(); return (document.getElementById("tree-search") as HTMLInputElement)?.focus();
        case "?": return s.openModal({ kind: "help", title: "keys" });
        case "a": if (sel) act(`/nodes/${sel.id}/approve`, {}); return;
        case "r": if (sel) return s.openModal({ kind: "text", title: `reject ${sel.title}`, placeholder: "what is wrong? (sent to the agent on re-dispatch)", onSubmit: (note) => act(`/nodes/${sel.id}/reject`, { note }) });
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

  return (
    <div className="app">
      <div className="panes">
        <Tree />
        <Detail />
      </div>
      <StatusBar />
      <Modal />
    </div>
  );
}

function act(path: string, body?: any, method?: string) {
  api(path, body, method).catch((e) => useStore.getState().notify(e.message));
}
/** node ids navigable with j/k, in the order the tree shows them */
function visibleIds(s: ReturnType<typeof useStore.getState>): string[] {
  const flat: string[] = [];
  const walk = (items: any[]) => { for (const t of items) { flat.push(t.id); if (s.expanded.has(t.id)) walk(t.children); } };
  walk(s.tree);
  return flat;
}
