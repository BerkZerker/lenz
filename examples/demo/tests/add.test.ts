import { test, expect } from "bun:test";
import { createStore } from "../src/store";

test("ex_684af7 adds a todo", () => {
  const s = createStore();
  const t = s.add("buy milk");
  expect(t).toEqual({ id: 1, title: "buy milk", done: false });
  expect(s.list()).toContainEqual(t);
});

test("ex_143fbd rejects empty title", () => {
  const s = createStore();
  expect(() => s.add("")).toThrow("title is required");
  expect(s.list()).toEqual([]);
});

test("ex_31c1fb rejects whitespace-only title", () => {
  const s = createStore();
  expect(() => s.add("   ")).toThrow("title is required");
  expect(s.list()).toEqual([]);
});

test("ex_ca5516 ids increment", () => {
  const s = createStore();
  expect(s.add("a").id).toBe(1);
  expect(s.add("b").id).toBe(2);
});
