import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DEFAULT_STRUCTURE_CONFIG } from "@lenz/structure";

export interface LenzConfig {
  languages: string[];
  source_globs: string[];
  ignore_globs: string[];
  entry_globs: string[];
  orphan_exclude: string[];
  test_command: string;
  max_concurrent_runs: number;
  lock_cooldown: number; // seconds
  run_timeout: number; // seconds
  example_timeout: number; // seconds
  port: number;
  model?: string; // optional model override for Claude Code build runs
  /** provider for the non-agentic calls (propose, derive, reconstruction, compare). Builds always use the Claude Code adapter. */
  llm: { provider: "gemini" | "claude"; model: string };
}

export const DEFAULT_CONFIG: LenzConfig = {
  languages: ["typescript", "tsx"],
  ...DEFAULT_STRUCTURE_CONFIG,
  test_command: "bun test",
  max_concurrent_runs: 2,
  lock_cooldown: 45,
  run_timeout: 20 * 60,
  example_timeout: 60,
  port: 7331,
  llm: { provider: "gemini", model: "gemini-3.7-flash" },
};

export const DEFAULT_AGENT_YAML = `# Claude Code adapter. {prompt_file} is fed on stdin; {settings_file} carries the lock hooks.
command: claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --settings {settings_file}
resume: claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --settings {settings_file} --resume {session_id}
events: claude-stream-json
hooks: claude-settings
`;

export function lenzDir(root: string) { return join(root, ".lenz"); }

export function loadConfig(root: string): LenzConfig {
  const p = join(lenzDir(root), "config.yaml");
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  const raw = YAML.parse(readFileSync(p, "utf8")) ?? {};
  return { ...DEFAULT_CONFIG, ...raw, llm: { ...DEFAULT_CONFIG.llm, ...(raw.llm ?? {}) } };
}

export function initProject(root: string) {
  const dir = lenzDir(root);
  mkdirSync(join(dir, "nodes"), { recursive: true });
  mkdirSync(join(dir, "agents"), { recursive: true });
  mkdirSync(join(dir, "runs"), { recursive: true });
  const cfgPath = join(dir, "config.yaml");
  if (!existsSync(cfgPath)) writeFileSync(cfgPath, YAML.stringify(DEFAULT_CONFIG));
  const agentPath = join(dir, "agents", "claude.yaml");
  if (!existsSync(agentPath)) writeFileSync(agentPath, DEFAULT_AGENT_YAML);
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "runs/\nstructure.db*\n.env\n");
  return dir;
}
