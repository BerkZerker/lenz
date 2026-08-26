import type { StructureDb } from "./db.ts";
import type { RawRef } from "./extract.ts";
import type { ImportRow, SymbolRow } from "./types.ts";

/**
 * Syntactic reference resolution: local file → import graph (following re-exports) → unresolved.
 * No confidence scores: an edge resolves or it lands in `unresolved`.
 */
export function resolveFileRefs(db: StructureDb, file: string, refs: RawRef[]) {
  db.clearRefsFrom(file);
  const local = db.symbolsInFile(file);
  const imports = db.importsOf(file);
  const importByLocal = new Map<string, ImportRow>();
  for (const i of imports) if (!i.reexport) importByLocal.set(i.local, i);
  const importedFiles = [...new Set(imports.map((i) => i.resolved_file).filter((f): f is string => !!f))];

  for (const r of refs) {
    const srcKey = r.srcKey ?? "@" + file; // "@file" = module-level reference
    let dst: SymbolRow | null = null;
    if (r.kind === "imports") {
      // bare identifier: only meaningful when it names an import binding
      const imp = importByLocal.get(r.name);
      if (!imp || !imp.resolved_file) continue;
      dst = lookupExport(db, imp.resolved_file, imp.imported === "default" ? null : imp.imported, r.name);
      if (!dst) { db.insertUnresolved({ src_key: srcKey, name: r.name, kind: r.kind, line: r.line }); continue; }
      if (dst.key === srcKey) continue;
      if (r.srcKey) db.insertRef({ src_key: srcKey, dst_key: dst.key, kind: "imports", provenance: "syntactic", line: r.line });
      continue;
    }
    // calls / extends / implements
    if (!r.member) {
      const imp = importByLocal.get(r.name);
      if (imp?.resolved_file) dst = lookupExport(db, imp.resolved_file, imp.imported === "default" ? null : imp.imported, r.name);
      if (!dst) dst = pickLocal(local, r.name, r.srcKey);
    } else {
      // obj.method(): prefer same-file methods, then methods in imported files, then any-file unique match
      dst = local.find((s) => s.name === r.name && s.kind === "method") ?? null;
      if (!dst) for (const f of importedFiles) { const c = db.symbolsInFile(f).find((s) => s.name === r.name && (s.kind === "method" || s.kind === "function")); if (c) { dst = c; break; } }
      if (!dst) { const all = db.symbolsByName(r.name).filter((s) => s.kind === "method"); if (all.length === 1) dst = all[0]; }
    }
    if (dst) {
      if (dst.key !== srcKey && r.srcKey) db.insertRef({ src_key: srcKey, dst_key: dst.key, kind: r.kind, provenance: "syntactic", line: r.line });
    } else db.insertUnresolved({ src_key: srcKey, name: r.name, kind: r.kind, line: r.line });
  }
}

function pickLocal(local: SymbolRow[], name: string, srcKey: string | null): SymbolRow | null {
  const cands = local.filter((s) => s.name === name);
  if (!cands.length) return null;
  if (srcKey) {
    // prefer same container as the caller
    const srcContainer = local.find((s) => s.key === srcKey)?.container ?? "";
    const same = cands.find((s) => s.container === srcContainer);
    if (same) return same;
  }
  return cands.find((s) => s.container === "") ?? cands[0];
}

/** Find the symbol exported as `name` from `file`, following re-exports. `name === null` means default export. */
export function lookupExport(db: StructureDb, file: string, name: string | null, localHint: string, depth = 0): SymbolRow | null {
  if (depth > 6) return null;
  const syms = db.symbolsInFile(file);
  if (name) {
    const hit = syms.find((s) => s.name === name && s.container === "") ?? syms.find((s) => s.name === name);
    if (hit) return hit;
  } else {
    // default export: best effort — an exported symbol whose name matches the local binding, else the single exported top-level symbol
    const hit = syms.find((s) => s.name === localHint && s.exported) ?? (syms.filter((s) => s.exported && s.container === "").length === 1 ? syms.find((s) => s.exported && s.container === "") : undefined);
    if (hit) return hit;
  }
  // re-exports
  for (const i of db.importsOf(file)) {
    if (!i.reexport || !i.resolved_file) continue;
    if (i.imported === "*" && i.local === "*") { const r = lookupExport(db, i.resolved_file, name, localHint, depth + 1); if (r) return r; }
    else if (name && i.local === name) { const r = lookupExport(db, i.resolved_file, i.imported === "default" ? null : i.imported, localHint, depth + 1); if (r) return r; }
  }
  return null;
}
