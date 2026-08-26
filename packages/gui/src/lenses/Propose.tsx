import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { NodeCard } from "../components/common";

export function ProposeLens() {
  const { nodes, selected, setSelected, focus, notify } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const proposed = Object.values(nodes).filter((n) => n.status === "proposed").sort((a, b) => a.title.localeCompare(b.title));
  const intents = Object.values(nodes).filter((n) => n.kind === "intent");
  const [parent, setParent] = useState<string>(focus && nodes[focus]?.kind === "intent" ? focus : "");
  const submit = async () => {
    if (!text.trim()) return; setBusy(true);
    try { const r = await api("/propose", { text, parent: parent || null }); notify(`proposed ${r.created.length} nodes`); setText(""); } catch (e: any) { notify(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="section"><div className="section-h">brain-dump → proposed tree</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe what you want built. Voice: use OS dictation into this box. The agent proposes intent/behavior nodes with specs and examples; nothing is built until you approve." spellCheck={false} />
        <div className="row">
          <span className="dim">under:</span><select value={parent} onChange={(e) => setParent(e.target.value)}><option value="">root</option>{intents.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select>
          <button className="primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? "proposing…" : "propose"}</button>
          <span className="dim">fan-out ≤ 9 enforced; retried once on violation</span>
        </div>
      </div>
      <div className="section"><div className="section-h">proposed — awaiting approval ({proposed.length})</div>
        <div className="cards">{proposed.map((n) => <NodeCard key={n.id} n={n} selected={n.id === selected} onClick={() => setSelected(n.id)} extra={<>
          <button className="primary" onClick={(e) => { e.stopPropagation(); api(`/nodes/${n.id}/approve`, {}); }}>approve</button>
          <button onClick={(e) => { e.stopPropagation(); api(`/nodes/${n.id}`, undefined, "DELETE"); }}>delete</button></>} />)}</div>
        {!proposed.length && <div className="dim">nothing proposed. a approves the selected subtree · e edits · x deletes · regroup by editing `parent` in the yaml.</div>}
      </div>
    </>
  );
}
