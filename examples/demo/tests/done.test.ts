import { test, expect } from "bun:test";
import { createStore } from "../src/store";

test("ex_67cbac marks done", () => {
  const s = createStore();
  s.add("a");
  const t = s.done(1);
  expect(t).toEqual({ id: 1, title: "a", done: true });
  expect(s.list().find((x) => x.id === 1)?.done).toBe(true);
});

test("ex_47e6d2 unknown id errors", () => {
  const s = createStore();
  s.add("a");
  expect(() => s.done(99)).toThrow(new Error("todo not found: 99"));
  expect(s.list()).toEqual([{ id: 1, title: "a", done: false }]);
});

test("ex_0affda idempotent", () => {
  const s = createStore();
  s.add("a");
  s.done(1);
  expect(() => s.done(1)).not.toThrow();
  expect(s.done(1).done).toBe(true);
});
