import { anchorKey, type StructureDb } from "./db.ts";
import type { Anchor, SymbolRow } from "./types.ts";

export type AnchorStatus = "ok" | "moved" | "renamed" | "changed" | "deleted";
export interface AnchorResolution { status: AnchorStatus; anchor: Anchor; key: string; drift: boolean }

export function toAnchor(s: SymbolRow): Anchor { return { kind: s.kind, name: s.name, container: s.container, file: s.file, sig: s.sig, body: s.body }; }

/**
 * Re-resolve an anchor against the current structure.
 *   miss on file  → same body elsewhere      → moved   (no drift)
 *   miss on name  → same file + sig          → renamed (no drift)
 *   body differs  → same file + name         → changed (drift)
 *   everything    →                          → deleted (drift)
 */
export function resolveAnchor(db: StructureDb, a: Anchor): AnchorResolution {
  const key = anchorKey(a);
  const exact = db.symbol(key);
  if (exact) {
    if (exact.body === a.body) return { status: "ok", anchor: toAnchor(exact), key, drift: false };
    return { status: "changed", anchor: toAnchor(exact), key, drift: true };
  }
  const moved = db.symbolsByBody(a.body, a.kind).filter((s) => s.name === a.name);
  if (moved.length) { const m = moved[0]; return { status: "moved", anchor: toAnchor(m), key: m.key, drift: false }; }
  const renamed = db.symbolsInFile(a.file).filter((s) => s.kind === a.kind && s.container === a.container && s.sig === a.sig && s.body === a.body);
  if (renamed.length === 1) { const m = renamed[0]; return { status: "renamed", anchor: toAnchor(m), key: m.key, drift: false }; }
  const sameFileSig = db.symbolsInFile(a.file).filter((s) => s.kind === a.kind && s.container === a.container && s.sig === a.sig);
  if (sameFileSig.length === 1) { const m = sameFileSig[0]; return { status: "renamed", anchor: toAnchor(m), key: m.key, drift: false }; }
  const anyBody = db.symbolsByBody(a.body, a.kind);
  if (anyBody.length === 1) { const m = anyBody[0]; return { status: "moved", anchor: toAnchor(m), key: m.key, drift: false }; }
  return { status: "deleted", anchor: a, key, drift: true };
}
