import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StructureIndex, SymbolsChanged } from "@lenz/structure";
import type { EventBus } from "../events.ts";
import type { LockBroker } from "../locks.ts";
import type { RunKind, RunRecord } from "../types.ts";
import { buildCommand, loadAdapter, parseStreamJsonLine, writeClaudeSettings, type AgentAdapter } from "./adapter.ts";
import { geminiGenerate } from "../llm/gemini.ts";
import { openaiGenerate, OPENROUTER_BASE } from "../llm/openai.ts";
import type { LlmConfig } from "../config.ts";

export interface RunSpec {
  kind: RunKind;
  node: string | null;
  prompt: string;
  note?: string;
  /** extra CLI args (e.g. --json-schema, --tools) — Claude adapter only */
  extra?: string[];
  /** JSON schema for structured output (both providers) */
  schema?: any;
  /** short structured LLM call: runs against max_concurrent_llm instead of max_concurrent_runs */
  light?: boolean;
  session_id?: string;
}
export interface RunOutcome { run: RunRecord; text: string; structured?: any }

interface Active {
  rec: RunRecord; changed: Map<string, "added" | "changed" | "removed">; resolve: (o: RunOutcome) => void; text: string;
  light: boolean; structured?: any; killed?: string;
  proc?: ReturnType<typeof Bun.spawn>; timer?: ReturnType<typeof setTimeout>; abort?: AbortController;
}
type SpawnedRun = Active & { proc: NonNullable<Active["proc"]>; timer: NonNullable<Active["timer"]> };

export interface RunManagerOpts {
  root: string; lenzDir: string; runsDir: string; port: number;
  cli: string[]; // argv prefix to invoke the lenz CLI
  maxConcurrent: () => number; maxConcurrentLlm: () => number; timeoutSec: () => number; model?: () => string | undefined;
  llm: () => LlmConfig;
}

/** Owns agent processes: queueing, concurrency, timeouts, run records, changed-symbol capture. */
export class RunManager {
  runs = new Map<string, RunRecord>();
  private queue: { spec: RunSpec; rec: RunRecord; resolve: (o: RunOutcome) => void }[] = [];
  private active = new Map<string, Active>();
  adapter: AgentAdapter;
  constructor(private opts: RunManagerOpts, private bus: EventBus, private locks: LockBroker, private idx: StructureIndex) {
    this.adapter = loadAdapter(opts.lenzDir);
    mkdirSync(opts.runsDir, { recursive: true });
    idx.on("symbols_changed", (ev: SymbolsChanged) => this.onSymbolsChanged(ev));
  }

  list() { return [...this.runs.values()].sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? "")); }
  get(id: string) { return this.runs.get(id) ?? null; }
  runningFor(nodeId: string) { return [...this.active.values()].find((a) => a.rec.node === nodeId)?.rec ?? this.queue.find((q) => q.rec.node === nodeId)?.rec ?? null; }
  buildingNodes() { return new Set([...this.active.values()].filter((a) => a.rec.kind === "build" && a.rec.node).map((a) => a.rec.node!)); }

  submit(spec: RunSpec): { id: string; done: Promise<RunOutcome> } {
    const id = `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const rec: RunRecord = { id, kind: spec.kind, node: spec.node, status: "queued", note: spec.note };
    this.runs.set(id, rec);
    const done = new Promise<RunOutcome>((resolve) => { this.queue.push({ spec, rec, resolve }); });
    this.bus.publish("run.updated", { run: rec });
    this.pump();
    return { id, done };
  }

  /** Heavy (agent) runs and light (structured LLM) runs have independent concurrency caps. */
  private pump(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const q = this.queue[i];
      let heavy = 0, light = 0;
      for (const a of this.active.values()) a.light ? light++ : heavy++;
      if (q.spec.light ? light >= this.opts.maxConcurrentLlm() : heavy >= this.opts.maxConcurrent()) continue;
      this.queue.splice(i, 1); i--;
      this.start(q.spec, q.rec, q.resolve); // registers in `active` synchronously, so the next iteration sees it
    }
  }

  private start(spec: RunSpec, rec: RunRecord, resolve: (o: RunOutcome) => void) {
    const dir = join(this.opts.runsDir, rec.id);
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, "prompt.md");
    const settingsFile = join(dir, "settings.json");
    writeFileSync(promptFile, spec.prompt);
    const llm = this.opts.llm();
    if (spec.light && llm.provider !== "claude") { void this.startLlm(spec, rec, resolve, dir, llm); return; }
    if (spec.schema) spec.extra = [...(spec.extra ?? []), "--json-schema", JSON.stringify(spec.schema)];
    writeClaudeSettings(settingsFile, { cli: this.opts.cli, runId: rec.id, port: this.opts.port, model: this.opts.model?.() });
    const argv = buildCommand(this.adapter, { prompt_file: promptFile, settings_file: settingsFile, session_id: spec.session_id }, spec.extra ?? []);
    rec.status = "running"; rec.started_at = new Date().toISOString();
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...rec, argv }, null, 2));
    const proc = Bun.spawn(argv, {
      cwd: this.opts.root,
      stdin: Bun.file(promptFile),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, LENZ_RUN: rec.id, LENZ_PORT: String(this.opts.port), LENZ_ROOT: this.opts.root, CLAUDECODE: undefined as any },
    });
    const timer = setTimeout(() => this.kill(rec.id, "timeout"), this.opts.timeoutSec() * 1000);
    const act: SpawnedRun = { rec, proc, timer, changed: new Map(), resolve, text: "", light: !!spec.light };
    this.active.set(rec.id, act);
    this.bus.publish("run.updated", { run: rec });
    this.consume(act, dir);
    this.finish(act, dir);
  }

  private async consume(act: SpawnedRun, dir: string) {
    const reader = (act.proc.stdout as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder(); let buf = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      appendFileSync(join(dir, "events.jsonl"), line + "\n");
      const ev = parseStreamJsonLine(line);
      if (!ev) return;
      if (ev.session_id && !act.rec.session_id) act.rec.session_id = ev.session_id;
      if (ev.text) act.text = ev.text; // last assistant text wins
      if (ev.result) { act.text = ev.result.text || act.text; act.structured = ev.result.structured; act.rec.cost_usd = ev.result.cost; if (ev.result.is_error) act.rec.error = ev.result.subtype ?? "error"; }
      this.bus.publish("run.event", { run: act.rec.id, node: act.rec.node, kind: act.rec.kind, event: summarize(ev) });
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      if (buf.trim()) handle(buf);
    } catch {}
  }

  private async finish(act: SpawnedRun, dir: string) {
    const stderr = await new Response(act.proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
    const exit = await act.proc.exited;
    clearTimeout(act.timer);
    const rec = act.rec;
    rec.exit = exit; rec.ended_at = new Date().toISOString();
    rec.duration = (Date.parse(rec.ended_at) - Date.parse(rec.started_at!)) / 1000;
    rec.locks_held = this.locks.heldBy(rec.id);
    rec.changed_symbols = [...act.changed.keys()];
    rec.result_text = act.text;
    rec.status = act.killed === "timeout" ? "timeout" : act.killed ? "killed" : exit === 0 && !rec.error ? "done" : "failed";
    if (exit !== 0 && stderr.trim()) rec.error = (rec.error ? rec.error + ": " : "") + stderr.trim().slice(-2000);
    if (stderr.trim()) writeFileSync(join(dir, "stderr.log"), stderr);
    this.locks.releaseAll(rec.id);
    this.active.delete(rec.id);
    writeFileSync(join(dir, "result.json"), JSON.stringify({ changed_symbols: [...act.changed].map(([key, change]) => ({ key, change })), locks_held: rec.locks_held, exit, duration: rec.duration, status: rec.status, session_id: rec.session_id, cost_usd: rec.cost_usd, error: rec.error }, null, 2));
    this.bus.publish("run.updated", { run: rec });
    act.resolve({ run: rec, text: act.text, structured: act.structured });
    (rec as any).changes = [...act.changed].map(([key, change]) => ({ key, change }));
    this.pump();
  }

  /** In-process LLM call for light runs (gemini or any OpenAI-compatible endpoint); same run record / run dir contract. */
  private async startLlm(spec: RunSpec, rec: RunRecord, resolve: (o: RunOutcome) => void, dir: string, llm: LlmConfig) {
    rec.status = "running"; rec.started_at = new Date().toISOString(); rec.provider = `${llm.provider}:${llm.model}`;
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...rec, provider: rec.provider }, null, 2));
    const abort = new AbortController();
    this.active.set(rec.id, { rec, light: true, abort, changed: new Map(), resolve, text: "" });
    this.bus.publish("run.updated", { run: rec });
    const r = await this.callLlm(llm, spec, abort.signal);
    rec.ended_at = new Date().toISOString(); rec.duration = (Date.parse(rec.ended_at) - Date.parse(rec.started_at)) / 1000;
    rec.exit = r.error ? 1 : 0; rec.error = r.error; rec.result_text = r.text; rec.status = r.error ? "failed" : "done"; rec.tokens = r.usage;
    // the transcript is a nicety; losing the run dir (a wiped .lenz, a torn-down test root) must not strand the caller
    try {
      appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ type: "result", provider: rec.provider, text: r.text, structured: r.structured, usage: r.usage, error: r.error }) + "\n");
      writeFileSync(join(dir, "result.json"), JSON.stringify({ changed_symbols: [], locks_held: [], exit: rec.exit, duration: rec.duration, status: rec.status, provider: rec.provider, usage: r.usage, error: r.error }, null, 2));
    } catch (e) { this.bus.publish("log", { level: "warn", msg: `run ${rec.id}: could not write transcript (${e})` }); }
    this.bus.publish("run.event", { run: rec.id, node: rec.node, kind: rec.kind, event: { type: "result", subtype: rec.status, text: (r.text ?? "").slice(0, 2000), tokens: r.usage } });
    this.active.delete(rec.id);
    this.bus.publish("run.updated", { run: rec });
    resolve({ run: rec, text: r.text, structured: r.structured });
    this.pump();
  }

  /** Provider dispatch for light runs. `key()` reports a missing key as a run error rather than throwing. */
  private callLlm(llm: LlmConfig, spec: RunSpec, signal: AbortSignal): Promise<{ text: string; structured?: any; usage?: { prompt: number; output: number; thoughts?: number }; error?: string }> {
    const timeoutMs = this.opts.timeoutSec() * 1000;
    const key = (envVar: string) => process.env[llm.api_key_env ?? envVar] ?? "";
    if (llm.provider === "gemini") {
      const apiKey = key("GEMINI_API_KEY");
      if (!apiKey) return Promise.resolve({ text: "", error: `${llm.api_key_env ?? "GEMINI_API_KEY"} not set (put it in <project>/.env or .lenz/.env)` });
      return geminiGenerate({ apiKey, model: llm.model, prompt: spec.prompt, schema: spec.schema, timeoutMs, signal });
    }
    const baseUrl = llm.base_url ?? OPENROUTER_BASE;
    const apiKey = key("OPENROUTER_API_KEY");
    // a self-hosted OpenAI-compatible server needs no key; only the hosted default demands one
    if (!apiKey && baseUrl === OPENROUTER_BASE) return Promise.resolve({ text: "", error: `${llm.api_key_env ?? "OPENROUTER_API_KEY"} not set (put it in <project>/.env or .lenz/.env)` });
    return openaiGenerate({ baseUrl, apiKey, model: llm.model, prompt: spec.prompt, schema: spec.schema, strict: llm.strict_schema, timeoutMs, signal });
  }

  kill(id: string, reason = "killed") {
    const act = this.active.get(id);
    if (act) { act.killed = reason; act.abort?.abort(); try { act.proc?.kill(); } catch {} return true; }
    const qi = this.queue.findIndex((q) => q.rec.id === id);
    if (qi >= 0) { const [q] = this.queue.splice(qi, 1); q.rec.status = "killed"; q.rec.ended_at = new Date().toISOString(); this.bus.publish("run.updated", { run: q.rec }); q.resolve({ run: q.rec, text: "" }); return true; }
    return false;
  }

  /** Symbols added/changed/removed while a run held (or nobody else held) the file are attributed to that run. */
  private onSymbolsChanged(ev: SymbolsChanged) {
    const builds = [...this.active.values()].filter((a) => a.rec.kind === "build");
    if (!builds.length) return;
    const attribute = (key: string, change: "added" | "changed" | "removed") => {
      const file = key.split("#")[0];
      const holder = this.locks.holder(file);
      const targets = holder ? builds.filter((b) => b.rec.id === holder) : builds;
      for (const b of targets) b.changed.set(key, change);
    };
    for (const k of ev.added) attribute(k, "added");
    for (const k of ev.changed) attribute(k, "changed");
    for (const k of ev.removed) attribute(k, "removed");
  }
  changesFor(runId: string): { key: string; change: string }[] { return (this.runs.get(runId) as any)?.changes ?? []; }
  changedSymbolsInFile(file: string): string[] {
    const out = new Set<string>();
    for (const a of this.active.values()) for (const k of a.changed.keys()) if (k.startsWith(file + "#")) out.add(k.split("#").pop()!);
    return [...out];
  }
}

function summarize(ev: ReturnType<typeof parseStreamJsonLine>) {
  const raw = ev!.raw;
  if (raw.type === "system" && raw.subtype === "init") return { type: "init", model: raw.model, session_id: raw.session_id };
  if (ev!.tool) return { type: "tool", name: ev!.tool.name, input: shortInput(ev!.tool.input) };
  if (ev!.text) return { type: "text", text: ev!.text.slice(0, 2000) };
  if (raw.type === "user" && raw.message?.content) {
    const c = raw.message.content.find?.((x: any) => x.type === "tool_result");
    if (c) { const t = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : ""; return { type: "tool_result", is_error: !!c.is_error, text: t.slice(0, 600) }; }
  }
  if (ev!.result) return { type: "result", subtype: raw.subtype, cost: raw.total_cost_usd, turns: raw.num_turns, text: ev!.result.text.slice(0, 2000) };
  return null;
}
function shortInput(i: any) {
  if (!i || typeof i !== "object") return i;
  const o: any = {};
  for (const [k, v] of Object.entries(i)) o[k] = typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v;
  return o;
}
