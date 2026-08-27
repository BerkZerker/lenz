import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One gitignore line, compiled. Rules are applied in order and the last match wins. */
export interface IgnoreRule { re: RegExp; negate: boolean; dirOnly: boolean; source: string }

/** Files read for ignore rules, in order — later files override earlier ones. */
export const IGNORE_FILES = [".gitignore", ".lenzignore"];

/** Translate one gitignore pattern to a regex anchored at the project root. */
function compile(raw: string): IgnoreRule | null {
  let p = raw.replace(/\s+$/, "");                       // trailing spaces are insignificant unless escaped
  if (!p || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  if (p.startsWith("\\#") || p.startsWith("\\!")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  if (!p) return null;
  // a pattern with no slash (other than a trailing one) matches at any depth; anything else is rooted
  const rooted = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const before = i === 0 || p[i - 1] === "/", after = p[i + 2] === "/" || i + 2 === p.length;
        if (before && after) { re += p[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += p[i + 2] === "/" ? 2 : 1; continue; }
        re += ".*"; i++; continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") { const end = p.indexOf("]", i); if (end < 0) { re += "\\["; } else { re += p.slice(i, end + 1); i = end; } }
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  // a directory pattern also covers everything beneath it
  return { re: new RegExp(`^${rooted ? "" : "(?:.*/)?"}${re}(?:/.*)?$`), negate, dirOnly, source: raw };
}

export function parseIgnore(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).map(compile).filter((r): r is IgnoreRule => !!r);
}

/** Read the ignore files present at `root`, in order. Missing files are simply skipped. */
export function loadIgnoreRules(root: string, names: string[] = IGNORE_FILES): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (const n of names) {
    const p = join(root, n);
    if (!existsSync(p)) continue;
    try { out.push(...parseIgnore(readFileSync(p, "utf8"))); } catch {}
  }
  return out;
}

/**
 * Is `rel` (a project-relative POSIX path) excluded? Ancestor directories are tested too: git cannot re-include a
 * file whose parent directory is excluded, so an ignored folder ends the walk.
 */
export function isIgnored(rules: IgnoreRule[], rel: string): boolean {
  if (!rules.length || !rel) return false;
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    const isDir = i < parts.length;
    let hit = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(sub)) hit = !r.negate;
    }
    if (hit) return true;
  }
  return false;
}

export const DEFAULT_LENZIGNORE = `# Folders lenz should not index, in .gitignore syntax.
# .gitignore is honoured automatically; this file is for anything extra you want lenz to skip
# so the graph covers only the code you are working on.

# vendored or generated code
**/generated/**
**/*.min.js

# examples and fixtures — uncomment to focus the graph on the product itself
# examples/**
# **/fixtures/**
# **/__snapshots__/**
`;
