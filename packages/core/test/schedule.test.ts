import { expect, test } from "bun:test";
import { pooled, runDag } from "../src/core.ts";

const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

test("pooled: runs everything, never exceeding the limit", async () => {
  const seen: number[] = [];
  let inFlight = 0, peak = 0;
  await pooled([...Array(20).keys()], 4, async (i) => {
    peak = Math.max(peak, ++inFlight);
    await tick(2);
    inFlight--; seen.push(i);
  });
  expect(seen.sort((a, b) => a - b)).toEqual([...Array(20).keys()]);
  expect(peak).toBe(4);
});

test("runDag: a key starts only after everything it waits for has finished", async () => {
  // src waits for src/a and src/b; src/a waits for src/a/deep
  const waits: Record<string, string[]> = { "src": ["src/a", "src/b"], "src/a": ["src/a/deep"], "src/b": [], "src/a/deep": [] };
  const finished: string[] = [];
  await runDag(Object.keys(waits), (k) => waits[k], 8, async (k) => {
    for (const d of waits[k]) expect(finished).toContain(d); // deps are done before we start
    await tick(2);
    finished.push(k);
  });
  expect(finished.length).toBe(4);
  expect(finished.indexOf("src")).toBe(3);
  expect(finished.indexOf("src/a")).toBeGreaterThan(finished.indexOf("src/a/deep"));
});

test("runDag: independent keys overlap instead of running one at a time", async () => {
  const keys = [...Array(12).keys()].map((i) => `f${i}`);
  let inFlight = 0, peak = 0;
  await runDag(keys, () => [], 6, async () => { peak = Math.max(peak, ++inFlight); await tick(5); inFlight--; });
  expect(peak).toBe(6);
});

test("runDag: a slow branch does not hold back an unrelated one (no barrier between depths)", async () => {
  // slow/leaf is slow; fast and fast/leaf must both finish before slow's parent does
  const waits: Record<string, string[]> = { "slow": ["slow/leaf"], "slow/leaf": [], "fast": ["fast/leaf"], "fast/leaf": [] };
  const delay: Record<string, number> = { "slow/leaf": 40, "slow": 1, "fast/leaf": 1, "fast": 1 };
  const finished: string[] = [];
  await runDag(Object.keys(waits), (k) => waits[k], 4, async (k) => { await tick(delay[k]); finished.push(k); });
  expect(finished.indexOf("fast")).toBeLessThan(finished.indexOf("slow"));
});

test("runDag: unreachable keys (cycle) resolve rather than hang", async () => {
  const waits: Record<string, string[]> = { a: ["b"], b: ["a"], c: [] };
  const finished: string[] = [];
  await runDag(Object.keys(waits), (k) => waits[k], 4, async (k) => { finished.push(k); });
  expect(finished).toEqual(["c"]);
});
