import type { Example, ExampleResult } from "../types.ts";

export async function runCommand(cmd: string, cwd: string, timeoutSec: number): Promise<{ exit: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" } });
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} }, timeoutSec * 1000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  clearTimeout(t);
  return { exit: timedOut ? null : exit, stdout, stderr, timedOut };
}

export function judge(ex: Example, out: { exit: number | null; stdout: string; stderr: string; timedOut: boolean }): { pass: boolean | null; note?: string } {
  const mode = ex.expect?.mode ?? "exit0";
  if (out.timedOut) return { pass: false, note: "timed out" };
  switch (mode) {
    case "exit0": return { pass: out.exit === 0 };
    case "stdout_equals": return { pass: out.stdout.trim() === String(ex.expect?.value ?? "").trim() };
    case "stdout_contains": return { pass: out.stdout.includes(String(ex.expect?.value ?? "")) };
    case "json_subset": {
      try { return { pass: isSubset(ex.expect?.value, JSON.parse(out.stdout)) }; } catch (e) { return { pass: false, note: "stdout is not JSON" }; }
    }
    case "manual": return { pass: null, note: "manual judgment required" };
  }
  return { pass: false, note: `unknown expect.mode ${mode}` };
}

export function isSubset(expected: any, actual: any): boolean {
  if (expected === null || typeof expected !== "object") return expected === actual;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e) => actual.some((a) => isSubset(e, a)));
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected).every(([k, v]) => isSubset(v, actual[k]));
}

export async function runExamples(examples: Example[], cwd: string, timeoutSec: number, onOne?: (r: ExampleResult) => void): Promise<ExampleResult[]> {
  const results: ExampleResult[] = [];
  for (const ex of examples) {
    const at = new Date().toISOString();
    if (!ex.run) { const r: ExampleResult = { id: ex.id, pass: ex.expect?.mode === "manual" ? null : false, actual: "", exit: null, at, note: ex.expect?.mode === "manual" ? "manual judgment required" : "no run command" }; results.push(r); onOne?.(r); continue; }
    const out = await runCommand(ex.run, cwd, timeoutSec);
    const j = judge(ex, out);
    const actual = (out.stdout + (out.stderr ? "\n[stderr]\n" + out.stderr : "")).trim();
    const r: ExampleResult = { id: ex.id, pass: j.pass, actual: actual.length > 6000 ? actual.slice(0, 3000) + "\n…\n" + actual.slice(-3000) : actual, exit: out.exit, at, note: j.note };
    results.push(r); onOne?.(r);
  }
  return results;
}
