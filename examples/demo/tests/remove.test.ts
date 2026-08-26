import { test, expect } from "bun:test";
import { createStore } from "../src/store";

test("ex_11a4b9 deletes a todo", () => {
  const s = createStore();
  s.add("a"); s.add("b");
  s.remove(1);
  expect(s.list().map((t) => t.id)).toEqual([2]);
});

test("ex_aebac8 unknown id errors", () => {
  const s = createStore();
  s.add("a");
  expect(() => s.remove(5)).toThrow(new Error("todo not found: 5"));
  expect(s.list().map((t) => t.id)).toEqual([1]);
});

test("ex_92e142 ids not reused", () => {
  const s = createStore();
  s.add("a");
  s.remove(1);
  expect(s.add("x").id).toBe(2);
});
