import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorKey, type StructureIndex } from "@lenzgraph/structure";
import type { NodeStore } from "../nodes.ts";
import type { LenzNode } from "../types.ts";
import YAML from "yaml";

export interface PromptContext { root: string; lenzDir: string; cliCommand: string; runId: string }

function conventions(lenzDir: string) {
  const p = join(lenzDir, "CONVENTIONS.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export function oneLine(s: string, n = 140) { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }

/** Prompt for a build run. */
export function buildPrompt(node: LenzNode, store: NodeStore, idx: StructureIndex, ctx: PromptContext, note?: string): string {
  const parts: string[] = [];
  const conv = conventions(ctx.lenzDir);
  if (conv) parts.push(`# Project conventions\n\n${conv}`);
  const parent = node.parent ? store.get(node.parent) : null;
  parts.push(`# Task\n\nYou are implementing one behavior node of this project. Work only toward this node's spec; do not build anything the spec does not ask for.\n\n## Node ${node.id}: ${node.title}${parent ? `\n\nParent intent: ${parent.title}` : ""}\n\n### Spec\n\n${node.spec.trim()}`);
  if (note) parts.push(`### Rejection note from the last review\n\n${note}`);
  const exs = node.examples ?? [];
  if (exs.length) parts.push(`### Examples (each must be made to pass)\n\n` + exs.map((e) => `- **${e.id}** ${e.name}\n  - given: ${e.given ?? "-"}\n  - when: ${e.when ?? "-"}\n  - then: ${e.then ?? "-"}${e.run ? `\n  - current run: \`${e.run}\`` : ""}`).join("\n"));
  const siblings = (parent ? store.children(parent.id) : store.children(null)).filter((s) => s.id !== node.id);
  const deps = node.deps.map((d) => store.get(d)).filter((d): d is LenzNode => !!d);
  if (siblings.length || deps.length) {
    parts.push(`### Related nodes (context only — do not implement these)\n\n` +
      [...deps.map((d) => `- dep ${d.id} [${d.status}] ${d.title} — ${oneLine(d.spec)}`), ...siblings.map((s) => `- sibling ${s.id} [${s.status}] ${s.title} — ${oneLine(s.spec)}`)].join("\n"));
  }
  const anchors = node.anchors ?? [];
  if (anchors.length) {
    const src = anchors.map((a) => { const s = idx.symbolSource(anchorKey(a)); return s ? `// ${a.file} — ${a.kind} ${a.container ? a.container + "." : ""}${a.name}\n${s}` : null; }).filter(Boolean);
    if (src.length) parts.push(`### Currently anchored code (this is what the node owns today)\n\n\`\`\`\n${src.join("\n\n")}\n\`\`\``);
  }
  parts.push(`# File locks\n\nOther agents may be editing this repository concurrently. Every file write is checked against a lock broker via a hook. If a write is denied because another run holds the file, do not retry in a loop: work on other files first, or wait and retry later. If you are told another run edited a file you held, re-read it before continuing.`);
  parts.push(`# Output contract\n\n1. Make each example's \`run\` command pass. If an example has no \`run\` yet, write a test (using the project's test runner) that exercises exactly the given/when/then, and register its command:\n   \`${ctx.cliCommand} node set ${node.id} examples.<example-id>.run "<command>"\`\n   The command runs from the project root and must exit 0 iff the example passes.\n2. Optionally register a broader machine check (e.g. the node's whole test file):\n   \`${ctx.cliCommand} node set ${node.id} machine.run "<command>"\`\n3. Do not edit files under .lenzgraph/ directly — use the command above.\n4. Keep changes minimal and scoped to this node. Finish with a short summary of what you changed.`);
  return parts.join("\n\n") + "\n";
}

export function reconstructPrompt(sources: { header: string; text: string }[], callees: string[]): string {
  return `You are reading code with no other context. Describe precisely what this code does, including edge cases, error handling, and invariants — as a behavior description a product owner could read. Do not speculate about intent beyond what the code shows. Do not use any tools.\n\n\`\`\`\n${sources.map((s) => `// ${s.header}\n${s.text}`).join("\n\n")}\n\`\`\`\n${callees.length ? `\nSignatures of things it calls:\n${callees.map((c) => "- " + c).join("\n")}\n` : ""}\nRespond with the description only.`;
}

export function comparePrompt(spec: string, examples: LenzNode["examples"], reconstruction: string): string {
  return `Compare a SPEC (what was intended) with a RECONSTRUCTION (what an independent reader says the code does). Decide whether the code matches the spec. Mismatch means the code does something the spec forbids, omits something the spec requires, or the reconstruction is too vague to tell (illegible code is a mismatch). Do not use any tools.\n\n## SPEC\n\n${spec}\n\n${(examples ?? []).length ? "### Examples\n\n" + examples!.map((e) => `- ${e.name}: given ${e.given ?? "-"}; when ${e.when ?? "-"}; then ${e.then ?? "-"}`).join("\n") + "\n\n" : ""}## RECONSTRUCTION\n\n${reconstruction}\n\nRespond with JSON: {"verdict": "match" | "mismatch", "reasons": string[]} — reasons are short and concrete (empty for a clean match).`;
}

export const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    nodes: { type: "array", items: { $ref: "#/$defs/node" } },
  },
  required: ["nodes"],
  $defs: {
    node: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["intent", "behavior"] },
        title: { type: "string" },
        spec: { type: "string" },
        deps: { type: "array", items: { type: "string" }, description: "titles of sibling behavior nodes that must be built first" },
        examples: { type: "array", items: { type: "object", properties: { name: { type: "string" }, given: { type: "string" }, when: { type: "string" }, then: { type: "string" } }, required: ["name", "given", "when", "then"] } },
        children: { type: "array", items: { $ref: "#/$defs/node" } },
      },
      required: ["kind", "title", "spec"],
    },
  },
};

export function proposePrompt(brainDump: string, existingTree: string, parentTitle: string | null): string {
  return `You are turning a human's brain-dump into a tree of nodes for an agent dev kit.\n\nTwo node kinds: **intent** nodes group (title + one-paragraph spec, children); **behavior** nodes are leaves that own code (title, precise spec, 1–4 examples as given/when/then). Rules:\n- A node has at most 9 children. Group into intent nodes to stay under the cap.\n- Behavior specs are contracts: inputs, outputs, errors, limits. Concrete enough that an agent can implement without asking questions, no larger than the brain-dump asks for.\n- Examples are observable behavior, never test code.\n- deps: list titles of sibling behaviors that must exist first (e.g. "login" before "reset password").\n- Do not repeat nodes that already exist in the tree below; propose only what is new.\n${parentTitle ? `- The new nodes will be placed under the existing intent node "${parentTitle}".\n` : ""}\n${existingTree ? `## Existing tree\n\n${existingTree}\n\n` : ""}## Brain-dump\n\n${brainDump}\n\nYou may read the repository to understand conventions, but do not modify anything. Return the tree as JSON matching the schema.`;
}

export const DERIVE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "object", properties: { title: { type: "string" }, spec: { type: "string" } }, required: ["title", "spec"] },
    behaviors: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, spec: { type: "string" },
      anchors: { type: "array", items: { type: "string" }, description: "symbol keys from the list, verbatim" },
      examples: { type: "array", items: { type: "object", properties: { name: { type: "string" }, given: { type: "string" }, when: { type: "string" }, then: { type: "string" } }, required: ["name", "given", "when", "then"] } },
    }, required: ["title", "spec", "anchors"] } },
  },
  required: ["intent", "behaviors"],
};

export function derivePrompt(folder: string, symbols: { key: string; kind: string; name: string; container: string; file: string; sig: string; doc: string }[], subIntents: { title: string; spec: string }[]): string {
  return `You are deriving behavior nodes from existing code, bottom-up, one folder at a time. Folder: \`${folder || "."}\`.\n\nGroup this folder's symbols into 1–9 **behavior** nodes: each is a user-observable behavior (title, precise spec of what the code does, 1–3 examples as given/when/then describing observable behavior). Every symbol should be owned by exactly one behavior; a symbol can appear in only one node's anchors. Anchors must be symbol keys copied verbatim from the list. Also write one **intent** node summarizing this folder (title + one-paragraph spec), taking the subfolders' intents into account.\n\n## Symbols in this folder's files\n\n${symbols.map((s) => `- key: \`${s.key}\`\n  ${s.kind} ${s.container ? s.container + "." : ""}${s.name}${s.sig ? ` — ${oneLine(s.sig, 160)}` : ""}${s.doc ? `\n  ${oneLine(s.doc, 200)}` : ""}`).join("\n")}\n\n${subIntents.length ? `## Already-derived subfolder intents\n\n${subIntents.map((s) => `- ${s.title}: ${oneLine(s.spec, 200)}`).join("\n")}\n\n` : ""}Do not use tools. Return JSON matching the schema.`;
}

export function nodeToYamlForPrompt(n: LenzNode) { return YAML.stringify({ title: n.title, spec: n.spec, examples: n.examples }); }
