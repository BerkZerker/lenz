import { test, expect } from "bun:test";
import { createStore } from "../src/store";

function seeded() {
  const s = createStore();
  const a = s.add("a");
  const b = s.add("b");
  b.done = true;
  return { s, a, b };
}

test("ex_da2f98 lists all", () => {
  const { s, a, b } = seeded();
  expect(s.list()).toEqual([a, b]);
});

test("ex_55c98f filters open", () => {
  const { s, a } = seeded();
  expect(s.list("open")).toEqual([a]);
});

test("ex_e9e910 filters done", () => {
  const { s, b } = seeded();
  expect(s.list("done")).toEqual([b]);
});

test("ex_7551cf invalid filter errors", () => {
  const s = createStore();
  expect(() => s.list("archived" as any)).toThrow(new Error("invalid filter: archived"));
});
