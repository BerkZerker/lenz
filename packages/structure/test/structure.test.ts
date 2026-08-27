import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructureIndex, DEFAULT_STRUCTURE_CONFIG, resolveAnchor, toAnchor, flowFrom, normalize, isGenerated } from "../src/index.ts";

let root: string; let idx: StructureIndex;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lg-"));
  cpSync(join(import.meta.dir, "fixture"), root, { recursive: true });
  idx = new StructureIndex({ ...DEFAULT_STRUCTURE_CONFIG, root, dbPath: ":memory:" });
  await idx.indexAll();
});
afterAll(async () => { await idx.close(); rmSync(root, { recursive: true, force: true }); });

describe("extraction", () => {
  test("symbols with kinds, containers, exported flags", () => {
    const syms = idx.db.symbolsInFile("src/auth/reset.ts");
    const names = syms.map((s) => `${s.kind}:${s.container}:${s.name}:${s.exported}`);
    expect(names).toContain("const::tokens:1");
    expect(names).toContain("function::requestReset:1");
    expect(names).toContain("function::consumeReset:1");
    expect(names).toContain("class::ResetError:1");
    expect(names).toContain("method:ResetError:describe:1");
    expect(idx.db.symbolsInFile("src/mailer.ts").map((s) => s.name)).toEqual(["Mailer", "send"]);
  });
  test("normalize strips comments and whitespace", () => {
    expect(normalize("function a() { // hi\n  return 1 /* x */ }")).toBe("function a() { return 1 }");
  });
});

describe("references", () => {
  test("calls resolve through imports, locals, and re-exports", () => {
    const main = idx.db.refsFrom("src/index.ts##function#main");
    const dst = main.map((r) => `${r.kind}→${r.dst_key}`);
    expect(dst).toContain("calls→src/auth/reset.ts##function#requestReset");
    expect(dst).toContain("calls→src/auth/reset.ts##function#consumeReset");
    expect(dst).toContain("calls→src/mailer.ts##class#Mailer");
    expect(main.every((r) => r.provenance === "syntactic")).toBe(true);
    const consume = idx.db.refsFrom("src/auth/reset.ts##function#consumeReset").map((r) => r.dst_key);
    expect(consume).toContain("src/auth/hash.ts##function#hashPassword");
    const req = idx.db.refsFrom("src/auth/reset.ts##function#requestReset").map((r) => r.dst_key);
    expect(req).toContain("src/mailer.ts#Mailer#method#send");
  });
  test("extends edge and unresolved externals", () => {
    const cls = idx.db.refsFrom("src/auth/reset.ts##class#ResetError");
    expect(cls.some((r) => r.kind === "extends")).toBe(false); // Error is external → unresolved
    expect(idx.db.unresolvedAll().some((u) => u.name === "Error")).toBe(true);
  });
  test("entry points from entry_globs", () => {
    expect(idx.db.entryPoints().map((e) => e.key)).toEqual(["src/index.ts##function#main"]);
  });
  test("flow tree ordered by source position", () => {
    const f = flowFrom(idx.db, "src/index.ts##function#main")!;
    expect(f.children.map((c) => c.symbol.name)).toEqual(["Mailer", "requestReset", "consumeReset"]);
    expect(f.children[1].children.map((c) => c.symbol.name)).toContain("send");
  });
});

describe("sync + anchors", () => {
  test("incremental sync emits added/changed/removed; anchors resolve moved/renamed/changed/deleted", async () => {
    const hashKey = "src/auth/hash.ts##function#hashPassword";
    const original = toAnchor(idx.db.symbol(hashKey)!);
    const consumeAnchor = toAnchor(idx.db.symbol("src/auth/reset.ts##function#consumeReset")!);

    // body change → drift
    writeFileSync(join(root, "src/auth/hash.ts"), 'export function hashPassword(pw: string) { return "sha:" + pw; }\n');
    const ev = await idx.sync(["src/auth/hash.ts"]);
    expect(ev.changed).toEqual([hashKey]);
    expect(resolveAnchor(idx.db, original).status).toBe("changed");

    // moved to another file → re-anchor, no drift
    writeFileSync(join(root, "src/auth/hash.ts"), "export const nothing = 1;\n");
    writeFileSync(join(root, "src/auth/hash2.ts"), 'export function hashPassword(pw: string) { return "sha:" + pw; }\n');
    const changedAnchor = { ...original, body: idx.db.symbol(hashKey)!.body, sig: idx.db.symbol(hashKey)!.sig };
    const ev2 = await idx.sync(["src/auth/hash.ts", "src/auth/hash2.ts"]);
    expect(ev2.removed).toContain(hashKey);
    expect(ev2.added).toContain("src/auth/hash2.ts##function#hashPassword");
    const r = resolveAnchor(idx.db, changedAnchor);
    expect(r.status).toBe("moved"); expect(r.drift).toBe(false); expect(r.anchor.file).toBe("src/auth/hash2.ts");

    // renamed in place (same sig? no: sig includes name) → same body+file → renamed
    const src = readFileSync(join(root, "src/auth/reset.ts"), "utf8").replace("function consumeReset(", "function consumeResetToken(");
    writeFileSync(join(root, "src/auth/reset.ts"), src);
    await idx.sync(["src/auth/reset.ts"]);
    const rr = resolveAnchor(idx.db, consumeAnchor);
    expect(["renamed", "changed"]).toContain(rr.status);

    // deleted
    rmSync(join(root, "src/auth/hash2.ts"));
    await idx.sync([], ["src/auth/hash2.ts"]);
    expect(resolveAnchor(idx.db, r.anchor).status).toBe("deleted");
  });
  test("orphans and ownership joins", () => {
    expect(idx.db.orphans().length).toBeGreaterThan(0);
    idx.db.setAnchors("n_1", ["src/index.ts##function#main"]);
    expect(idx.db.orphans().some((s) => s.key === "src/index.ts##function#main")).toBe(false);
    expect(idx.db.ownersOf("src/index.ts##function#main")).toEqual(["n_1"]);
    expect(idx.db.neighborOwners(["src/auth/reset.ts##function#requestReset"])).toEqual(["n_1"]);
  });
});

test("minified build output is never indexed as source", () => {
  const bundle = "var a=1;".repeat(20000); // ~160KB on one line, like a vite bundle
  expect(isGenerated(bundle)).toBe(true);
  expect(isGenerated("const x = 1;\n".repeat(20000))).toBe(false); // big but real source
  expect(isGenerated("const x = 1;\n")).toBe(false);
});
