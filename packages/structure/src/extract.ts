import Parser from "web-tree-sitter";
import type { SyntaxNode } from "web-tree-sitter";
import { readFileSync } from "node:fs";
import { LANGUAGES, languageForFile, queryPath, wasmPath, type LanguageDef, type ImportBinding } from "./languages.ts";
import { symbolKey, type RefKind, type SymbolKind, type SymbolRow } from "./types.ts";
import { createHash } from "node:crypto";

export interface RawRef { srcKey: string | null; name: string; kind: RefKind; line: number; member: boolean }
export interface Extraction {
  symbols: SymbolRow[];
  refs: RawRef[];
  imports: ImportBinding[];
  hash: string;
  language: string;
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<string, { lang: Parser.Language; query: Parser.Query; parser: Parser }>();

async function ensureInit() {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

async function loadLanguage(def: LanguageDef) {
  await ensureInit();
  let entry = langCache.get(def.id);
  if (!entry) {
    const lang = await Parser.Language.load(wasmPath(def));
    const query = lang.query(readFileSync(queryPath(def), "utf8"));
    const parser = new Parser();
    parser.setLanguage(lang);
    entry = { lang, query, parser };
    langCache.set(def.id, entry);
  }
  return entry;
}

export function hashText(t: string) { return createHash("sha1").update(t).digest("hex").slice(0, 12); }
export function contentHash(t: string) { return createHash("sha1").update(t).digest("hex"); }

/** Strip comments and collapse whitespace for stable hashing. */
export function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/g, "$1")
    .replace(/(^|\n)\s*#[^\n]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const FN_TYPES = new Set(["function_declaration", "generator_function_declaration", "arrow_function", "function_expression", "method_definition", "function_definition", "method_declaration", "func_literal"]);
function isFunctionLocal(node: SyntaxNode): boolean {
  let n = node.parent;
  while (n) { if (FN_TYPES.has(n.type)) return true; n = n.parent; }
  return false;
}

function containerOf(node: SyntaxNode, def: LanguageDef): string {
  const parts: string[] = [];
  let n = node.parent;
  while (n) {
    if (def.containerTypes.includes(n.type)) {
      const nm = n.childForFieldName("name")?.text;
      if (nm) parts.unshift(nm);
      else if (n.type === "object") {
        // const X = { m() {} } → container X
        const decl = n.parent;
        const nm2 = decl?.type === "variable_declarator" ? decl.childForFieldName("name")?.text : undefined;
        if (nm2) parts.unshift(nm2);
      }
    }
    n = n.parent;
  }
  return parts.join(".");
}

function signatureOf(node: SyntaxNode, def: LanguageDef, kind: SymbolKind): string {
  // For declarator-wrapped consts/functions the node is the declarator
  const body = node.childForFieldName(def.bodyField) ?? node.childForFieldName("value")?.childForFieldName(def.bodyField);
  if (body) return node.text.slice(0, body.startIndex - node.startIndex);
  if (kind === "const") {
    const nm = node.childForFieldName("name");
    const ty = node.childForFieldName("type");
    return (nm?.text ?? "") + (ty ? ty.text : "");
  }
  return node.text.split("{")[0];
}

export async function extractFile(absPath: string, relPath: string, source?: string): Promise<Extraction | null> {
  const def = languageForFile(relPath);
  if (!def) return null;
  const text = source ?? readFileSync(absPath, "utf8");
  const { query, parser } = await loadLanguage(def);
  const tree = parser.parse(text);
  const root = tree.rootNode;

  const symbols: SymbolRow[] = [];
  const defNodes: { node: SyntaxNode; row: SymbolRow }[] = [];
  const seen = new Set<string>();
  const refsRaw: { node: SyntaxNode; name: string; kind: RefKind; member: boolean }[] = [];
  const imports: ImportBinding[] = [];

  for (const m of query.matches(root)) {
    const defCap = m.captures.find((c) => c.name.startsWith("definition."));
    const refCap = m.captures.find((c) => c.name.startsWith("reference."));
    const nameCap = m.captures.find((c) => c.name === "name");
    if (defCap && nameCap) {
      const kind = defCap.name.slice("definition.".length) as SymbolKind;
      const node = defCap.node;
      const rangeKey = `${node.startIndex}:${node.endIndex}`;
      if (seen.has(rangeKey)) continue; // first (most specific) pattern wins
      seen.add(rangeKey);
      const name = nameCap.node.text.replace(/^\[|\]$/g, "");
      if (kind !== "method" && isFunctionLocal(node)) continue; // locals inside function bodies are not symbols (methods of returned object literals are)
      const container = containerOf(node, def);
      const row: SymbolRow = {
        key: symbolKey({ kind, name, container, file: relPath }),
        kind, name, container, file: relPath,
        sig: hashText(normalize(signatureOf(node, def, kind).replace(name, "_"))),
        body: hashText(normalize(node.text)),
        start_line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1,
        exported: def.isExported(node, name) ? 1 : 0,
      };
      symbols.push(row);
      defNodes.push({ node, row });
    } else if (refCap) {
      const kindRaw = refCap.name.slice("reference.".length);
      if (kindRaw === "import") { imports.push(...def.parseImport(refCap.node)); continue; }
      if (kindRaw === "ident") {
        // bare identifiers: only interesting if they name an import binding (resolved later)
        const n = refCap.node;
        // skip identifiers that are the *name* of a definition or property keys
        if (n.parent && (n.parent.type.endsWith("declaration") || n.parent.type === "variable_declarator" || n.parent.type === "import_specifier" || n.parent.type === "pair")) {
          if (n.parent.childForFieldName("name")?.id === n.id || n.parent.childForFieldName("key")?.id === n.id) continue;
        }
        refsRaw.push({ node: n, name: n.text, kind: "imports", member: false });
        continue;
      }
      const kind: RefKind = kindRaw === "call" ? "calls" : (kindRaw as RefKind);
      const nameNode = nameCap?.node;
      if (!nameNode) continue;
      refsRaw.push({ node: refCap.node, name: nameNode.text, kind, member: nameNode.parent?.type === "member_expression" || nameNode.parent?.type === "attribute" || nameNode.parent?.type === "selector_expression" });
    }
  }

  // dedupe symbols on key (e.g. overloads) – keep the last (implementation)
  const byKey = new Map<string, SymbolRow>();
  for (const s of symbols) {
    const prev = byKey.get(s.key);
    if (prev) { prev.end_line = Math.max(prev.end_line, s.end_line); prev.body = hashText(prev.body + s.body); prev.sig = hashText(prev.sig + s.sig); }
    else byKey.set(s.key, s);
  }

  // attribute references to the innermost enclosing definition
  const sortedDefs = defNodes.slice().sort((a, b) => (a.node.endIndex - a.node.startIndex) - (b.node.endIndex - b.node.startIndex));
  const enclosing = (n: SyntaxNode): SymbolRow | null => {
    for (const d of sortedDefs) if (d.node.startIndex <= n.startIndex && d.node.endIndex >= n.endIndex && d.node.id !== n.id) return byKey.get(d.row.key) ?? d.row;
    return null;
  };
  const refs: RawRef[] = [];
  const refSeen = new Set<string>();
  for (const r of refsRaw) {
    const enc = enclosing(r.node);
    const srcKey = enc?.key ?? null;
    const k = `${srcKey}|${r.name}|${r.kind}`;
    if (refSeen.has(k)) continue;
    refSeen.add(k);
    refs.push({ srcKey, name: r.name, kind: r.kind, line: r.node.startPosition.row + 1, member: r.member });
  }
  tree.delete();
  return { symbols: [...byKey.values()], refs, imports, hash: contentHash(text), language: def.id };
}

export async function preloadLanguages(ids?: string[]) {
  for (const l of LANGUAGES) if (!ids || ids.includes(l.id)) await loadLanguage(l);
}
