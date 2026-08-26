import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import chokidar, { type FSWatcher } from "chokidar";
import { StructureDb } from "./db.ts";
import { extractFile, preloadLanguages, contentHash } from "./extract.ts";
import { languageForFile } from "./languages.ts";
import { resolveFileRefs } from "./resolve.ts";
import { parseScip } from "./scip.ts";
import type { SymbolRow, SymbolsChanged } from "./types.ts";

export interface StructureConfig {
  root: string;
  dbPath: string;
  source_globs: string[];
  ignore_globs: string[];
  entry_globs: string[];
  orphan_exclude: string[];
}

export const DEFAULT_STRUCTURE_CONFIG: Omit<StructureConfig, "root" | "dbPath"> = {
  source_globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.py", "**/*.go"],
  ignore_globs: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/.lenzgraph/**", "**/*.d.ts"],
  entry_globs: ["src/index.ts", "src/main.ts", "src/server.ts", "src/cli.ts", "src/app.ts"],
  orphan_exclude: ["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/test/**", "**/__tests__/**", "**/*.config.*", "**/*.generated.*"],
};

/**
 * The L2/L3 index: a sqlite mirror of the code that is kept in sync with disk.
 * Emits `symbols_changed` ({added, removed, changed, files}) after every sync.
 */
export class StructureIndex extends EventEmitter {
  db: StructureDb;
  cfg: StructureConfig;
  private isSource: (p: string) => boolean;
  private isIgnored: (p: string) => boolean;
  private isEntry: (p: string) => boolean;
  isOrphanExcluded: (p: string) => boolean;
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, "change" | "unlink">();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;

  constructor(cfg: StructureConfig) {
    super();
    this.cfg = cfg;
    this.db = new StructureDb(cfg.dbPath);
    this.isSource = picomatch(cfg.source_globs, { dot: false });
    this.isIgnored = picomatch(cfg.ignore_globs, { dot: true });
    this.isEntry = picomatch(cfg.entry_globs);
    this.isOrphanExcluded = picomatch(cfg.orphan_exclude);
  }

  rel(abs: string) { return relative(this.cfg.root, abs).split("\\").join("/"); }
  abs(rel: string) { return resolve(this.cfg.root, rel); }
  accepts(rel: string) { return !!languageForFile(rel) && this.isSource(rel) && !this.isIgnored(rel); }

  async listSourceFiles(): Promise<string[]> {
    const out: string[] = [];
    const glob = new Bun.Glob("**/*");
    for await (const p of glob.scan({ cwd: this.cfg.root, onlyFiles: true, dot: false })) {
      const rel = p.split("\\").join("/");
      if (this.accepts(rel)) out.push(rel);
    }
    return out.sort();
  }

  /** Full (incremental, hash-keyed) index of the project. */
  async indexAll(): Promise<SymbolsChanged> {
    await preloadLanguages();
    const files = await this.listSourceFiles();
    const known = new Set(this.db.allFiles().map((f) => f.path));
    const gone = [...known].filter((f) => !files.includes(f));
    return this.sync(files, gone);
  }

  /** Re-extract the given files (changed) and drop the given files (removed); re-resolve refs touching them. */
  async sync(changedRel: string[], removedRel: string[] = []): Promise<SymbolsChanged> {
    if (this.syncing) await this.syncing;
    let result!: SymbolsChanged;
    this.syncing = (async () => { result = await this.doSync(changedRel, removedRel); })();
    try { await this.syncing; } finally { this.syncing = null; }
    return result;
  }

  private async doSync(changedRel: string[], removedRel: string[]): Promise<SymbolsChanged> {
    const before = new Map<string, SymbolRow>();
    const touched = new Set<string>([...changedRel, ...removedRel]);
    const extracted: { rel: string; ex: NonNullable<Awaited<ReturnType<typeof extractFile>>> }[] = [];
    const reallyChanged: string[] = [];
    for (const rel of changedRel) {
      const abs = this.abs(rel);
      if (!existsSync(abs)) { removedRel.push(rel); continue; }
      let text: string;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      const h = contentHash(text);
      if (this.db.fileHash(rel) === h) continue;
      const ex = await extractFile(abs, rel, text);
      if (!ex) continue;
      extracted.push({ rel, ex });
      reallyChanged.push(rel);
    }
    const removedExisting = removedRel.filter((r) => this.db.fileHash(r) !== null);
    if (!extracted.length && !removedExisting.length) return { added: [], removed: [], changed: [], files: [] };

    // dependents: files importing any touched file must re-resolve
    const dependents = new Set<string>();
    for (const rel of touched) for (const f of this.db.filesImporting(rel)) dependents.add(f);

    this.db.transaction(() => {
      for (const rel of [...reallyChanged, ...removedExisting]) for (const s of this.db.symbolsInFile(rel)) before.set(s.key, s);
      for (const rel of removedExisting) this.db.deleteFile(rel);
      for (const { rel, ex } of extracted) {
        this.db.replaceSymbols(rel, ex.symbols);
        this.db.upsertFile(rel, ex.hash, ex.language);
        const lang = languageForFile(rel)!;
        this.db.replaceImports(rel, ex.imports.map((i) => {
          const r = lang.resolveModule(this.abs(rel), i.source, this.cfg.root);
          return { file: rel, local: i.local, imported: i.imported, source: i.source, resolved_file: r ? this.rel(r) : null, reexport: i.reexport ? 1 : 0 };
        }));
      }
      // files that newly resolve: any file whose imports pointed to a now-existing path
      for (const { rel } of extracted) for (const f of this.db.filesImporting(rel)) dependents.add(f);
      for (const { rel, ex } of extracted) resolveFileRefs(this.db, rel, ex.refs);
    });
    // re-resolve dependents (need re-extraction to get raw refs; cheap enough)
    const dep = [...dependents].filter((f) => !reallyChanged.includes(f) && !removedExisting.includes(f));
    for (const rel of dep) {
      const abs = this.abs(rel);
      if (!existsSync(abs)) continue;
      const ex = await extractFile(abs, rel);
      if (ex) this.db.transaction(() => resolveFileRefs(this.db, rel, ex.refs));
    }
    this.refreshEntryPoints();

    const after = new Map<string, SymbolRow>();
    for (const rel of reallyChanged) for (const s of this.db.symbolsInFile(rel)) after.set(s.key, s);
    const added: string[] = [], removed: string[] = [], changed: string[] = [];
    for (const [k, s] of after) {
      const b = before.get(k);
      if (!b) added.push(k);
      else if (b.body !== s.body || b.sig !== s.sig) changed.push(k);
    }
    for (const k of before.keys()) if (!after.has(k)) removed.push(k);
    const ev: SymbolsChanged = { added, removed, changed, files: [...reallyChanged, ...removedExisting] };
    this.emit("symbols_changed", ev);
    return ev;
  }

  refreshEntryPoints() {
    const keys: string[] = [];
    for (const f of this.db.allFiles()) if (this.isEntry(f.path)) for (const s of this.db.symbolsInFile(f.path)) if (s.exported) keys.push(s.key);
    this.db.setAutoEntryPoints(keys);
  }

  /** Load precise references from index.scip if present. Returns number of edges, or null if no index. */
  applyScip(): number | null {
    const p = join(this.cfg.root, "index.scip");
    if (!existsSync(p)) return null;
    const docs = parseScip(new Uint8Array(readFileSync(p)));
    // map scip symbol → our key via definition occurrences (line match)
    const defs = new Map<string, string>();
    const byFileLine = new Map<string, Map<number, SymbolRow[]>>();
    for (const s of this.db.allSymbols()) {
      let m = byFileLine.get(s.file); if (!m) { m = new Map(); byFileLine.set(s.file, m); }
      const arr = m.get(s.start_line) ?? []; arr.push(s); m.set(s.start_line, arr);
    }
    for (const d of docs) {
      const lines = byFileLine.get(d.path); if (!lines) continue;
      for (const o of d.occurrences) {
        if (!(o.roles & 1)) continue;
        const cands = lines.get(o.startLine + 1);
        if (!cands?.length) continue;
        const tail = o.symbol.replace(/[().#/]+$/, "").split(/[./#]/).pop()?.replace(/[()]/g, "") ?? "";
        const hit = cands.find((c) => c.name === tail) ?? cands[0];
        defs.set(o.symbol, hit.key);
      }
    }
    let n = 0;
    this.db.transaction(() => {
      this.db.deleteRefsByProvenance("scip");
      for (const d of docs) {
        const syms = this.db.symbolsInFile(d.path);
        if (!syms.length) continue;
        for (const o of d.occurrences) {
          if (o.roles & 1) continue;
          const dst = defs.get(o.symbol); if (!dst) continue;
          const line = o.startLine + 1;
          const src = syms.filter((s) => s.start_line <= line && s.end_line >= line).sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0];
          if (!src || src.key === dst) continue;
          const dstRow = this.db.symbol(dst);
          const kind = dstRow?.kind === "class" || dstRow?.kind === "interface" ? "imports" : "calls";
          this.db.insertRef({ src_key: src.key, dst_key: dst, kind, provenance: "scip", line });
          n++;
        }
      }
    });
    return n;
  }

  /** Watch source globs; re-extract changed files only, debounced 300ms. */
  watch() {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.cfg.root, {
      ignored: (p: string, stats?: any) => {
        const rel = this.rel(p);
        if (!rel || rel === ".") return false;
        if (this.isIgnored(rel) || rel.startsWith(".git")) return true;
        if (stats?.isFile?.() && !this.accepts(rel)) return true;
        return false;
      },
      ignoreInitial: true, persistent: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    const queue = (p: string, kind: "change" | "unlink") => {
      const rel = this.rel(p);
      if (!this.accepts(rel)) return;
      this.pending.set(rel, kind);
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 300);
    };
    this.watcher.on("add", (p) => queue(p, "change")).on("change", (p) => queue(p, "change")).on("unlink", (p) => queue(p, "unlink"));
  }
  private async flush() {
    const items = [...this.pending]; this.pending.clear();
    const changed = items.filter(([, k]) => k === "change").map(([f]) => f);
    const removed = items.filter(([, k]) => k === "unlink").map(([f]) => f);
    try { await this.sync(changed, removed); } catch (e) { this.emit("error", e); }
  }
  async close() { await this.watcher?.close(); this.watcher = null; this.db.close(); }

  /** Source text of a symbol (for prompts). */
  symbolSource(key: string): string | null {
    const s = this.db.symbol(key); if (!s) return null;
    try {
      const lines = readFileSync(this.abs(s.file), "utf8").split("\n");
      return lines.slice(s.start_line - 1, s.end_line).join("\n");
    } catch { return null; }
  }
  fileMtime(rel: string): number { try { return statSync(this.abs(rel)).mtimeMs; } catch { return 0; } }
}
