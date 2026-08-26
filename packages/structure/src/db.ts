import { Database } from "bun:sqlite";
import type { Anchor, ImportRow, RefRow, SymbolRow, UnresolvedRow } from "./types.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, language TEXT NOT NULL, indexed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, container TEXT NOT NULL, file TEXT NOT NULL,
  sig TEXT NOT NULL, body TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, exported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_body ON symbols(body);
CREATE TABLE IF NOT EXISTS refs (src_key TEXT NOT NULL, dst_key TEXT NOT NULL, kind TEXT NOT NULL, provenance TEXT NOT NULL, line INTEGER NOT NULL,
  PRIMARY KEY (src_key, dst_key, kind));
CREATE INDEX IF NOT EXISTS refs_dst ON refs(dst_key);
CREATE TABLE IF NOT EXISTS unresolved (src_key TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (file TEXT NOT NULL, local TEXT NOT NULL, imported TEXT NOT NULL, source TEXT NOT NULL, resolved_file TEXT, reexport INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS imports_file ON imports(file);
CREATE TABLE IF NOT EXISTS entry_points (key TEXT PRIMARY KEY, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anchors (node_id TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (node_id, key));
CREATE INDEX IF NOT EXISTS anchors_key ON anchors(key);
`;

export class StructureDb {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }

  // files
  fileHash(path: string): string | null { return (this.db.query("SELECT hash FROM files WHERE path=?").get(path) as any)?.hash ?? null; }
  allFiles(): { path: string; hash: string; language: string }[] { return this.db.query("SELECT path, hash, language FROM files ORDER BY path").all() as any; }
  upsertFile(path: string, hash: string, language: string) {
    this.db.query("INSERT INTO files(path,hash,language,indexed_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, language=excluded.language, indexed_at=excluded.indexed_at")
      .run(path, hash, language, new Date().toISOString());
  }
  deleteFile(path: string) {
    this.db.query("DELETE FROM refs WHERE src_key IN (SELECT key FROM symbols WHERE file=?) OR dst_key IN (SELECT key FROM symbols WHERE file=?)").run(path, path);
    this.db.query("DELETE FROM unresolved WHERE src_key IN (SELECT key FROM symbols WHERE file=?)").run(path);
    this.db.query("DELETE FROM entry_points WHERE source='auto' AND key IN (SELECT key FROM symbols WHERE file=?)").run(path);
    this.db.query("DELETE FROM symbols WHERE file=?").run(path);
    this.db.query("DELETE FROM imports WHERE file=?").run(path);
    this.db.query("DELETE FROM files WHERE path=?").run(path);
  }

  // symbols
  symbolsInFile(file: string): SymbolRow[] { return this.db.query("SELECT * FROM symbols WHERE file=? ORDER BY start_line").all(file) as any; }
  symbol(key: string): SymbolRow | null { return (this.db.query("SELECT * FROM symbols WHERE key=?").get(key) as any) ?? null; }
  symbolsByName(name: string): SymbolRow[] { return this.db.query("SELECT * FROM symbols WHERE name=?").all(name) as any; }
  symbolsByBody(body: string, kind: string): SymbolRow[] { return this.db.query("SELECT * FROM symbols WHERE body=? AND kind=?").all(body, kind) as any; }
  allSymbols(): SymbolRow[] { return this.db.query("SELECT * FROM symbols ORDER BY file, start_line").all() as any; }
  replaceSymbols(file: string, rows: SymbolRow[]) {
    this.db.query("DELETE FROM symbols WHERE file=?").run(file);
    const q = this.db.query("INSERT INTO symbols(key,kind,name,container,file,sig,body,start_line,end_line,exported) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for (const r of rows) q.run(r.key, r.kind, r.name, r.container, r.file, r.sig, r.body, r.start_line, r.end_line, r.exported);
  }

  // imports
  replaceImports(file: string, rows: ImportRow[]) {
    this.db.query("DELETE FROM imports WHERE file=?").run(file);
    const q = this.db.query("INSERT INTO imports(file,local,imported,source,resolved_file,reexport) VALUES(?,?,?,?,?,?)");
    for (const r of rows) q.run(r.file, r.local, r.imported, r.source, r.resolved_file, r.reexport);
  }
  importsOf(file: string): ImportRow[] { return this.db.query("SELECT * FROM imports WHERE file=?").all(file) as any; }
  filesImporting(file: string): string[] { return (this.db.query("SELECT DISTINCT file FROM imports WHERE resolved_file=?").all(file) as any[]).map((r) => r.file); }

  // refs
  clearRefsFrom(file: string) {
    this.db.query("DELETE FROM refs WHERE src_key IN (SELECT key FROM symbols WHERE file=?)").run(file);
    this.db.query("DELETE FROM unresolved WHERE src_key IN (SELECT key FROM symbols WHERE file=?) OR src_key = ?").run(file, "@" + file);
  }
  insertRef(r: RefRow) { this.db.query("INSERT OR IGNORE INTO refs(src_key,dst_key,kind,provenance,line) VALUES(?,?,?,?,?)").run(r.src_key, r.dst_key, r.kind, r.provenance, r.line); }
  insertUnresolved(r: UnresolvedRow) { this.db.query("INSERT INTO unresolved(src_key,name,kind,line) VALUES(?,?,?,?)").run(r.src_key, r.name, r.kind, r.line); }
  refsFrom(key: string): RefRow[] { return this.db.query("SELECT * FROM refs WHERE src_key=? ORDER BY line").all(key) as any; }
  refsTo(key: string): RefRow[] { return this.db.query("SELECT * FROM refs WHERE dst_key=?").all(key) as any; }
  allRefs(): RefRow[] { return this.db.query("SELECT * FROM refs").all() as any; }
  unresolvedAll(): UnresolvedRow[] { return this.db.query("SELECT * FROM unresolved").all() as any; }
  deleteRefsByProvenance(p: string) { this.db.query("DELETE FROM refs WHERE provenance=?").run(p); }

  // entry points
  setAutoEntryPoints(keys: string[]) {
    this.db.query("DELETE FROM entry_points WHERE source='auto'").run();
    const q = this.db.query("INSERT OR IGNORE INTO entry_points(key,source) VALUES(?, 'auto')");
    for (const k of keys) q.run(k);
  }
  pinEntryPoint(key: string, pinned: boolean) {
    if (pinned) this.db.query("INSERT OR REPLACE INTO entry_points(key,source) VALUES(?, 'pinned')").run(key);
    else this.db.query("DELETE FROM entry_points WHERE key=? AND source='pinned'").run(key);
  }
  entryPoints(): { key: string; source: string }[] { return this.db.query("SELECT e.key, e.source FROM entry_points e JOIN symbols s ON s.key=e.key ORDER BY s.file, s.start_line").all() as any; }

  // anchors mirror
  setAnchors(nodeId: string, keys: string[]) {
    this.db.query("DELETE FROM anchors WHERE node_id=?").run(nodeId);
    const q = this.db.query("INSERT OR IGNORE INTO anchors(node_id,key) VALUES(?,?)");
    for (const k of keys) q.run(nodeId, k);
  }
  deleteAnchors(nodeId: string) { this.db.query("DELETE FROM anchors WHERE node_id=?").run(nodeId); }
  ownersOf(key: string): string[] { return (this.db.query("SELECT node_id FROM anchors WHERE key=?").all(key) as any[]).map((r) => r.node_id); }
  orphans(): SymbolRow[] {
    return this.db.query("SELECT s.* FROM symbols s LEFT JOIN anchors a ON a.key = s.key WHERE a.node_id IS NULL ORDER BY s.file, s.start_line").all() as any;
  }
  ownedSymbols(): { key: string; node_id: string }[] { return this.db.query("SELECT key, node_id FROM anchors").all() as any; }
  /** nodes anchored to any symbol that references / is referenced by the given keys (one hop over refs) */
  neighborOwners(keys: string[]): string[] {
    if (!keys.length) return [];
    const ph = keys.map(() => "?").join(",");
    const rows = this.db.query(`
      SELECT DISTINCT a.node_id FROM refs r JOIN anchors a ON a.key = r.dst_key WHERE r.src_key IN (${ph})
      UNION
      SELECT DISTINCT a.node_id FROM refs r JOIN anchors a ON a.key = r.src_key WHERE r.dst_key IN (${ph})`).all(...keys, ...keys) as any[];
    return rows.map((r) => r.node_id);
  }
}

export function anchorKey(a: Anchor) { return `${a.file}#${a.container}#${a.kind}#${a.name}`; }
