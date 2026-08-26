import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DEFAULT_AGENT_YAML } from "../config.ts";

export interface AgentAdapter {
  command: string;
  resume?: string;
  events: "claude-stream-json";
  hooks: "claude-settings";
}

export function loadAdapter(lenzDir: string): AgentAdapter {
  const p = join(lenzDir, "agents", "claude.yaml");
  const raw = existsSync(p) ? readFileSync(p, "utf8") : DEFAULT_AGENT_YAML;
  const a = YAML.parse(raw) as AgentAdapter;
  if (!a.command) throw new Error("agent adapter: missing command");
  a.events ??= "claude-stream-json"; a.hooks ??= "claude-settings";
  return a;
}

/** Minimal shell-word splitter (quotes + backslash), enough for adapter command lines. */
export function splitArgs(s: string): string[] {
  const out: string[] = []; let cur = ""; let q: string | null = null; let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ""; has = false; } }
    else { cur += c; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

export function buildCommand(a: AgentAdapter, vars: { prompt_file: string; settings_file: string; session_id?: string }, extra: string[] = []): string[] {
  const tpl = vars.session_id && a.resume ? a.resume : a.command;
  const args = splitArgs(tpl.replace(/\s+/g, " ")).map((w) => w.replace(/\{(\w+)\}/g, (_, k) => (vars as any)[k] ?? ""));
  // {prompt_file} is delivered on stdin; drop an empty placeholder arg if the template placed it positionally
  return [...args.filter((w) => w !== ""), ...extra];
}

/** Generator id `claude-settings`: a settings file whose hooks route write tools through the lock broker. */
export function writeClaudeSettings(path: string, opts: { cli: string[]; runId: string; port: number; model?: string }) {
  const hook = (sub: string) => ({ type: "command", command: [...opts.cli, "hook", sub, "--run", opts.runId, "--port", String(opts.port)].map(shq).join(" "), timeout: 20 });
  const settings: any = {
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [hook("pre")] },
        { matcher: "Read|Glob|Grep", hooks: [hook("notices")] },
      ],
      PostToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash", hooks: [hook("post")] }],
    },
  };
  if (opts.model) settings.model = opts.model;
  writeFileSync(path, JSON.stringify(settings, null, 2));
}
function shq(s: string) { return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`; }

/** Parser id `claude-stream-json`. */
export interface ParsedEvent { raw: any; session_id?: string; text?: string; tool?: { name: string; input: any }; result?: { text: string; structured?: any; cost?: number; is_error?: boolean; subtype?: string } }
export function parseStreamJsonLine(line: string): ParsedEvent | null {
  const t = line.trim(); if (!t.startsWith("{")) return null;
  let raw: any; try { raw = JSON.parse(t); } catch { return null; }
  const ev: ParsedEvent = { raw };
  if (raw.session_id) ev.session_id = raw.session_id;
  if (raw.type === "assistant" && raw.message?.content) {
    for (const c of raw.message.content) {
      if (c.type === "text") ev.text = (ev.text ?? "") + c.text;
      if (c.type === "tool_use") ev.tool = { name: c.name, input: c.input };
    }
  }
  if (raw.type === "result") ev.result = { text: typeof raw.result === "string" ? raw.result : "", structured: raw.structured_output, cost: raw.total_cost_usd, is_error: !!raw.is_error, subtype: raw.subtype };
  return ev;
}
