import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const HELP: [string, string][] = [
  ["j / k", "move selection"], ["enter", "drill in / open"], ["esc / h", "up / close"], ["/", "search tree"],
  ["1–6", "lens: graph · queue · verify · orphans · runs · flow"], ["7 / 8", "propose · stage"],
  ["a", "approve (proposed → specified, built → verified)"], ["r", "reject with note (re-dispatch)"], ["e", "edit node (yaml)"], ["d", "dispatch build"],
  ["n", "new node under focus"], ["x", "delete node"], ["g", "generate / regenerate graph from code"], ["c", "confirm staged set"], ["i", "toggle immediate mode"], ["?", "this help"],
];

export function Modal() {
  const modal = useStore((s) => s.modal); const close = () => useStore.getState().openModal(null);
  const [v, setV] = useState(modal?.initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setV(modal?.initial ?? ""); setTimeout(() => ref.current?.focus(), 0); }, [modal]);
  if (!modal) return null;
  const submit = () => { modal.onSubmit?.(v); close(); };
  return (
    <div className="overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}>
        <h3>{modal.title}</h3>
        {modal.kind === "help" && <table><tbody>{HELP.map(([k, d]) => <tr key={k}><td><span className="kbd">{k}</span></td><td>{d}</td></tr>)}</tbody></table>}
        {modal.kind === "confirm" && <div className="row"><button className="primary" autoFocus onClick={submit}>confirm</button><button onClick={close}>cancel</button></div>}
        {modal.kind === "choice" && (
          <>
            {(modal.options ?? []).map((o) => <label key={o.value} className="row" style={{ cursor: "pointer", marginBottom: 6 }}><input type="radio" name="choice" checked={v === o.value} onChange={() => setV(o.value)} />{o.label}{o.hint && <span className="dim">— {o.hint}</span>}</label>)}
            <div className="row"><button className="primary" autoFocus onClick={submit}>confirm</button><button onClick={close}>cancel</button></div>
          </>
        )}
        {(modal.kind === "text" || modal.kind === "yaml") && (
          <>
            <textarea ref={ref} value={v} onChange={(e) => setV(e.target.value)} placeholder={modal.placeholder} style={{ minHeight: modal.kind === "yaml" ? 360 : 140 }} spellCheck={false} />
            <div className="row"><button className="primary" onClick={submit}>submit</button><button onClick={close}>cancel</button><span className="dim">ctrl+enter to submit · esc to cancel</span></div>
          </>
        )}
      </div>
    </div>
  );
}
