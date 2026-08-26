import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { areaColor } from "../colors";
import type { TreeItem } from "../types";
import { Dot } from "./common";
import { deriveGraph } from "../derive";

interface FileSym { key: string; kind: string; name: string; container: string; start_line: number; owner: string | null }
interface FileEntry { path: string; language: string; symbols: FileSym[] }
interface Folder { name: string; path: string; folders: Folder[]; files: FileEntry[] }

/** left pane: a VS Code style explorer with two views — the node tree (intents/behaviors) and the file tree (files → symbols → owning node) */
export function Tree() {
  const { tree, focus, selected, search, setFocus, setSelected, setSearch, nodes, treeMode, setTreeMode, expanded, toggleExpanded, setExpanded } = useStore();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const status = useStore((s) => s.status);
  useEffect(() => { if (treeMode === "files") api<FileEntry[]>("/files").then(setFiles).catch(() => {}); }, [treeMode, status?.orphans, status?.nodes]);
  const root = useMemo(() => buildFolders(files), [files]);
  const q = search.toLowerCase();

  const allNodeIds = () => { const out: string[] = []; const walk = (items: TreeItem[]) => { for (const t of items) if (t.children.length) { out.push(t.id); walk(t.children); } }; walk(tree); return out; };
  const allFileIds = () => { const out: string[] = []; const walk = (f: Folder) => { out.push("f:" + f.path); for (const x of f.folders) walk(x); for (const x of f.files) out.push("f:" + x.path); }; walk(root); return out; };
  const expandAll = () => setExpanded(treeMode === "nodes" ? allNodeIds() : allFileIds());
  const collapseAll = () => setExpanded([]);

  return (
    <div className="pane">
      <div className="pane-header"><span>{treeMode === "nodes" ? "nodes" : "files"}</span>
        <span className="tree-tools">
          <button className={treeMode === "nodes" ? "on" : ""} onClick={() => setTreeMode("nodes")} title="node tree (intents → behaviors)">nodes</button>
          <button className={treeMode === "files" ? "on" : ""} onClick={() => setTreeMode("files")} title="file tree (files → symbols → owner)">files</button>
          <button onClick={expandAll} title="expand all">⊞</button>
          <button onClick={collapseAll} title="collapse all">⊟</button>
        </span>
      </div>
      <div className="pane-body" style={{ padding: "8px 4px" }}>
        <input className="search" id="tree-search" placeholder="/ search" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        {treeMode === "nodes" ? <>
          <Row depth={0} chevron={null} cls={focus === null ? "focused" : ""} onClick={() => { setFocus(null); setSelected(null); }}><span className="ttl">app</span><span className="ln">{Object.keys(nodes).length}</span></Row>
          {renderNodes(tree, 1)}
          {!tree.length && <div className="hint" style={{ padding: "0 6px" }}>no nodes yet. press <span className="kbd">7</span> to propose from a brain-dump, or <span className="link" onClick={deriveGraph}>generate the graph</span> from existing code (<span className="kbd">g</span>).</div>}
        </> : <>
          {root.folders.map((f) => renderFolder(f, 0))}{root.files.map((f) => renderFile(f, 0))}
          {!files.length && <div className="hint" style={{ padding: "0 6px" }}>no indexed files yet.</div>}
        </>}
      </div>
    </div>
  );

  function renderNodes(items: TreeItem[], depth: number): React.ReactNode {
    return items.map((t) => {
      const match = !q || t.title.toLowerCase().includes(q) || t.id.includes(q);
      if (q && !match && !hasMatch(t, q)) return null;
      const open = q ? true : expanded.has(t.id);
      const has = t.children.length > 0;
      return (
        <div key={t.id}>
          <Row depth={depth} chevron={has ? open : null} onChevron={() => toggleExpanded(t.id)} title={t.id}
            cls={`${t.id === focus ? "focused" : ""} ${t.id === selected ? "selected" : ""}`}
            onClick={() => { setSelected(t.id); if (t.kind === "intent") { setFocus(t.id); if (has && expanded.has(t.id) && t.id === focus) toggleExpanded(t.id); } else setFocus(nodes[t.id]?.parent ?? null); }}>
            <Dot n={t} /><span className="ttl">{t.title}</span>{t.staged ? <span className="accent"> ·s</span> : ""}{t.needs_reverify ? <span className="warn"> ·r</span> : ""}
          </Row>
          {open && has && renderNodes(t.children, depth + 1)}
        </div>
      );
    });
  }
  function renderFolder(f: Folder, depth: number): React.ReactNode {
    if (q && !folderMatches(f, q)) return null;
    const id = "f:" + f.path; const open = q ? true : expanded.has(id);
    return (
      <div key={id}>
        <Row depth={depth} chevron={open} onChevron={() => toggleExpanded(id)} cls="folder" onClick={() => toggleExpanded(id)} title={f.path}><span className="ttl">{f.name}/</span></Row>
        {open && <>{f.folders.map((x) => renderFolder(x, depth + 1))}{f.files.map((x) => renderFile(x, depth + 1))}</>}
      </div>
    );
  }
  function renderFile(f: FileEntry, depth: number): React.ReactNode {
    const name = f.path.split("/").pop()!;
    if (q && !fileMatches(f, q)) return null;
    const id = "f:" + f.path; const open = q ? true : expanded.has(id);
    const owned = f.symbols.filter((s) => s.owner).length;
    const owners = [...new Set(f.symbols.map((s) => s.owner).filter(Boolean))] as string[];
    return (
      <div key={id}>
        <Row depth={depth} chevron={f.symbols.length ? open : null} onChevron={() => toggleExpanded(id)} cls="file" onClick={() => toggleExpanded(id)} title={`${f.path} · ${owned}/${f.symbols.length} symbols owned`}>
          <span className="ttl">{name}</span>
          <span className="ln" style={{ display: "inline-flex", gap: 2 }}>{owners.slice(0, 5).map((o) => <span key={o} className="dot" style={{ background: areaColor(nodes, o), margin: 0, width: 6, height: 6 }} />)}{owners.length > 5 && <span>+{owners.length - 5}</span>}</span>
        </Row>
        {open && f.symbols.map((s) => {
          if (q && !symMatches(s, q)) return null;
          const owner = s.owner ? nodes[s.owner] : null;
          return (
            <Row key={s.key} depth={depth + 1} chevron={null} cls={`sym ${owner ? "owned" : ""} ${owner && selected === owner.id ? "selected" : ""}`} title={owner ? `${s.key}\nowned by ${owner.title}` : `${s.key}\n(orphan — no owning node)`}
              onClick={() => { if (owner) { setSelected(owner.id); setFocus(owner.kind === "intent" ? owner.id : owner.parent); } }}>
              <span className="dot" style={{ background: owner ? areaColor(nodes, owner.id) : "transparent", border: owner ? "none" : "1px dashed #525252" }} />
              <span className="ttl">{s.container ? <span className="dim">{s.container}.</span> : ""}{s.name}</span><span className="ln">{s.kind} L{s.start_line}</span>
            </Row>
          );
        })}
      </div>
    );
  }
}

function Row({ depth, chevron, onChevron, cls, onClick, title, children }: { depth: number; chevron: boolean | null; onChevron?: () => void; cls?: string; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <div className={`tree-item ${cls ?? ""}`} style={{ paddingLeft: 4 + depth * 12 }} onClick={onClick} title={title}>
      <span className={`chev ${chevron === null ? "leaf" : ""}`} onClick={(e) => { if (chevron === null || !onChevron) return; e.stopPropagation(); onChevron(); }}>{chevron ? "▾" : "▸"}</span>
      {children}
    </div>
  );
}

function buildFolders(files: FileEntry[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/"); let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.folders.find((x) => x.path === path);
      if (!next) { next = { name: parts[i], path, folders: [], files: [] }; cur.folders.push(next); }
      cur = next;
    }
    cur.files.push(f);
  }
  const sort = (d: Folder) => { d.folders.sort((a, b) => a.name.localeCompare(b.name)); d.files.sort((a, b) => a.path.localeCompare(b.path)); d.folders.forEach(sort); };
  sort(root);
  return root;
}
function hasMatch(t: TreeItem, q: string): boolean { return t.children.some((c) => c.title.toLowerCase().includes(q) || hasMatch(c, q)); }
function symMatches(s: FileSym, q: string) { return s.name.toLowerCase().includes(q) || s.container.toLowerCase().includes(q); }
function fileMatches(f: FileEntry, q: string) { return f.path.toLowerCase().includes(q) || f.symbols.some((s) => symMatches(s, q)); }
function folderMatches(f: Folder, q: string): boolean { return f.files.some((x) => fileMatches(x, q)) || f.folders.some((x) => folderMatches(x, q)); }
