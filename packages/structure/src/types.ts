export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "const" | "namespace";
export type RefKind = "calls" | "imports" | "extends" | "implements";
export type Provenance = "scip" | "syntactic";

export interface SymbolRow {
  key: string;
  kind: SymbolKind;
  name: string;
  container: string;
  file: string; // project-relative
  sig: string;
  body: string;
  start_line: number;
  end_line: number;
  exported: number;
}
export interface RefRow { src_key: string; dst_key: string; kind: RefKind; provenance: Provenance; line: number }
export interface UnresolvedRow { src_key: string; name: string; kind: RefKind; line: number }
export interface ImportRow { file: string; local: string; imported: string; source: string; resolved_file: string | null; reexport: number }

/** An anchor as stored in node yaml. */
export interface Anchor {
  kind: SymbolKind;
  name: string;
  container: string;
  file: string;
  sig: string;
  body: string;
}

export function symbolKey(s: { kind: string; name: string; container: string; file: string }): string {
  return `${s.file}#${s.container}#${s.kind}#${s.name}`;
}
export function parseKey(key: string): { file: string; container: string; kind: SymbolKind; name: string } | null {
  const i1 = key.indexOf("#");
  if (i1 < 0) return null;
  const file = key.slice(0, i1);
  const rest = key.slice(i1 + 1);
  const parts = rest.split("#");
  if (parts.length < 3) return null;
  const container = parts[0];
  const kind = parts[1] as SymbolKind;
  const name = parts.slice(2).join("#");
  return { file, container, kind, name };
}

export interface SymbolsChanged { added: string[]; removed: string[]; changed: string[]; files: string[] }
