import { expect, test } from "bun:test";
import { isIgnored, parseIgnore } from "../src/ignore.ts";

const ig = (patterns: string, path: string) => isIgnored(parseIgnore(patterns), path);

test("bare names match at any depth; rooted patterns do not", () => {
  expect(ig("node_modules", "node_modules/x/y.ts")).toBe(true);
  expect(ig("node_modules", "packages/a/node_modules/x.ts")).toBe(true);
  expect(ig("/dist", "dist/out.js")).toBe(true);
  expect(ig("/dist", "packages/a/dist/out.js")).toBe(false);
});

test("directory-only patterns do not match a file of the same name", () => {
  expect(ig("build/", "build/main.js")).toBe(true);
  expect(ig("build/", "build")).toBe(false);       // the file `build` survives
  expect(ig("build", "build")).toBe(true);
});

test("globs stay within a path segment; ** crosses them", () => {
  expect(ig("*.min.js", "src/vendor/a.min.js")).toBe(true);
  expect(ig("src/*.ts", "src/a.ts")).toBe(true);
  expect(ig("src/*.ts", "src/deep/a.ts")).toBe(false);
  expect(ig("src/**/*.ts", "src/deep/nested/a.ts")).toBe(true);
  expect(ig("**/fixtures/**", "packages/x/test/fixtures/a.ts")).toBe(true);
});

test("later rules win, so a negation re-includes a file", () => {
  expect(ig("*.log\n!keep.log", "keep.log")).toBe(false);
  expect(ig("*.log\n!keep.log", "other.log")).toBe(true);
  expect(ig("!keep.log\n*.log", "keep.log")).toBe(true); // order matters
});

test("a file inside an excluded directory cannot be re-included", () => {
  // matches git: the directory is never descended into, so the negation has no effect
  expect(ig("examples/\n!examples/demo/src/a.ts", "examples/demo/src/a.ts")).toBe(true);
});

test("comments, blanks and trailing space are ignored", () => {
  expect(parseIgnore("# comment\n\n   \nsrc/").length).toBe(1);
  expect(ig("dist   ", "dist/a.js")).toBe(true);
});

test("no rules means nothing is excluded", () => {
  expect(isIgnored([], "anything/at/all.ts")).toBe(false);
});
