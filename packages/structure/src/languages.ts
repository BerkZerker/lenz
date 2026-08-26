import { dirname, join, resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import type { SyntaxNode } from "web-tree-sitter";

export interface ImportBinding {
  /** local binding name, or "*" for namespace / side-effect / re-export-all */
  local: string;
  /** exported name in the source module ("default", "*", or a name) */
  imported: string;
  /** raw module specifier */
  source: string;
  /** `export { x } from` / `export * from` */
  reexport: boolean;
}

export interface LanguageDef {
  id: string;
  wasm: string;
  query: string;
  extensions: string[];
  /** does this definition node produce an exported symbol? */
  isExported(def: SyntaxNode, name: string): boolean;
  /** parse an import-ish node into bindings */
  parseImport(node: SyntaxNode): ImportBinding[];
  /** resolve a module specifier to a file path (absolute) or null if external */
  resolveModule(fromFile: string, spec: string, root: string): string | null;
  /** ancestor node types that establish a container (class, namespace) */
  containerTypes: string[];
  /** text used for the signature: everything before the body */
  bodyField: string;
}

const wasmDir = () => dirname(require.resolve("tree-sitter-wasms/package.json")) + "/out";
const queryDir = () => resolve(import.meta.dir, "../queries");

function tsResolve(fromFile: string, spec: string, _root: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = resolve(dirname(fromFile), spec);
  const cands: string[] = [];
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const b of [base, stripped]) {
    cands.push(b, b + ".ts", b + ".tsx", b + ".mts", b + ".cts", b + ".js", b + ".jsx", b + ".mjs",
      join(b, "index.ts"), join(b, "index.tsx"), join(b, "index.js"));
  }
  for (const c of cands) {
    try { if (existsSync(c) && !isDir(c)) return c; } catch {}
  }
  return null;
}
function isDir(p: string) { try { return require("node:fs").statSync(p).isDirectory(); } catch { return false; } }

function tsIsExported(def: SyntaxNode, _name: string): boolean {
  let n: SyntaxNode | null = def;
  while (n) {
    if (n.type === "export_statement") return true;
    if (n.type === "program") return false;
    if (n.type === "class_body") {
      // a method is "exported" if its class is
      const cls = n.parent;
      return cls ? tsIsExported(cls, "") : false;
    }
    n = n.parent;
  }
  return false;
}

function tsParseImport(node: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  const src = node.childForFieldName("source");
  if (!src) return out;
  const source = src.text.slice(1, -1);
  const reexport = node.type === "export_statement";
  if (reexport) {
    // export * from | export { a, b as c } from
    let sawClause = false;
    for (const c of node.namedChildren) {
      if (c.type === "export_clause") {
        sawClause = true;
        for (const s of c.namedChildren) {
          if (s.type !== "export_specifier") continue;
          const name = s.childForFieldName("name")?.text ?? "";
          const alias = s.childForFieldName("alias")?.text ?? name;
          out.push({ local: alias, imported: name, source, reexport: true });
        }
      } else if (c.type === "namespace_export") {
        sawClause = true;
        out.push({ local: c.namedChildren[0]?.text ?? "*", imported: "*", source, reexport: true });
      }
    }
    if (!sawClause) out.push({ local: "*", imported: "*", source, reexport: true });
    return out;
  }
  const clause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!clause) { out.push({ local: "*", imported: "*", source, reexport: false }); return out; }
  for (const c of clause.namedChildren) {
    if (c.type === "identifier") out.push({ local: c.text, imported: "default", source, reexport: false });
    else if (c.type === "namespace_import") out.push({ local: c.namedChildren[0]?.text ?? "*", imported: "*", source, reexport: false });
    else if (c.type === "named_imports") {
      for (const s of c.namedChildren) {
        if (s.type !== "import_specifier") continue;
        const name = s.childForFieldName("name")?.text ?? "";
        const alias = s.childForFieldName("alias")?.text ?? name;
        out.push({ local: alias, imported: name, source, reexport: false });
      }
    }
  }
  return out;
}

const typescript: LanguageDef = {
  id: "typescript",
  wasm: "tree-sitter-typescript.wasm",
  query: "typescript.scm",
  extensions: [".ts", ".mts", ".cts"],
  isExported: tsIsExported,
  parseImport: tsParseImport,
  resolveModule: tsResolve,
  containerTypes: ["class_declaration", "abstract_class_declaration", "internal_module", "object"],
  bodyField: "body",
};
const tsx: LanguageDef = { ...typescript, id: "tsx", wasm: "tree-sitter-tsx.wasm", query: "tsx.scm", extensions: [".tsx", ".jsx", ".js", ".mjs", ".cjs"] };

const python: LanguageDef = {
  id: "python",
  wasm: "tree-sitter-python.wasm",
  query: "python.scm",
  extensions: [".py"],
  isExported: (_d, name) => !name.startsWith("_"),
  parseImport(node) {
    const out: ImportBinding[] = [];
    if (node.type === "import_statement") {
      for (const c of node.namedChildren) {
        if (c.type === "dotted_name") out.push({ local: c.text, imported: "*", source: c.text, reexport: false });
        else if (c.type === "aliased_import") out.push({ local: c.childForFieldName("alias")?.text ?? c.text, imported: "*", source: c.childForFieldName("name")?.text ?? "", reexport: false });
      }
    } else if (node.type === "import_from_statement") {
      const mod = node.childForFieldName("module_name")?.text ?? "";
      const names = node.namedChildren.filter((c) => c !== node.childForFieldName("module_name"));
      for (const c of names) {
        if (c.type === "dotted_name") out.push({ local: c.text, imported: c.text, source: mod, reexport: false });
        else if (c.type === "aliased_import") out.push({ local: c.childForFieldName("alias")?.text ?? "", imported: c.childForFieldName("name")?.text ?? "", source: mod, reexport: false });
        else if (c.type === "wildcard_import") out.push({ local: "*", imported: "*", source: mod, reexport: false });
      }
    }
    return out;
  },
  resolveModule(fromFile, spec, root) {
    const rel = spec.startsWith(".");
    const parts = spec.replace(/^\.+/, "").split(".").filter(Boolean);
    const base = rel ? resolve(dirname(fromFile), ...parts) : resolve(root, ...parts);
    for (const c of [base + ".py", join(base, "__init__.py")]) if (existsSync(c)) return c;
    return null;
  },
  containerTypes: ["class_definition"],
  bodyField: "body",
};

const go: LanguageDef = {
  id: "go",
  wasm: "tree-sitter-go.wasm",
  query: "go.scm",
  extensions: [".go"],
  isExported: (_d, name) => /^[A-Z]/.test(name),
  parseImport(node) {
    const out: ImportBinding[] = [];
    const walk = (n: SyntaxNode) => {
      if (n.type === "import_spec") {
        const path = n.childForFieldName("path")?.text.slice(1, -1) ?? "";
        const alias = n.childForFieldName("name")?.text ?? path.split("/").pop() ?? path;
        out.push({ local: alias, imported: "*", source: path, reexport: false });
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(node);
    return out;
  },
  resolveModule: () => null, // package-level resolution: same-package symbols are local
  containerTypes: [],
  bodyField: "body",
};

export const LANGUAGES: LanguageDef[] = [typescript, tsx, python, go];

export function languageForFile(path: string): LanguageDef | null {
  const ext = extname(path);
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}
export function wasmPath(l: LanguageDef) { return join(wasmDir(), l.wasm); }
export function queryPath(l: LanguageDef) { return join(queryDir(), l.query); }
