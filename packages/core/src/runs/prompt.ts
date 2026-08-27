import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorKey, type StructureIndex } from "@lenz/structure";
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
  parts.push(`# File locks\n\nOther agents may be editing this repository concurrently. Every file write is checked against a lock broker via a hook. Use the Write and Edit tools to modify files (not shell redirection or scripts) so the broker can see each write. If a write is denied because another run holds the file, do not retry in a loop: work on other files first, or wait and retry later. If you are told another run edited a file you held, re-read it before continuing.`);
  parts.push(`# Output contract\n\n1. Make each example's \`run\` command pass. If an example has no \`run\` yet, write a test (using the project's test runner) that exercises exactly the given/when/then, and register its command:\n   \`${ctx.cliCommand} node set ${node.id} examples.<example-id>.run "<command>"\`\n   The command runs from the project root and must exit 0 iff the example passes.\n2. Optionally register a broader machine check (e.g. the node's whole test file):\n   \`${ctx.cliCommand} node set ${node.id} machine.run "<command>"\`\n3. Do not edit files under .lenz/ directly — use the command above.\n4. Keep changes minimal and scoped to this node. Finish with a short summary of what you changed.`);
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
        examples: { type: "array", items: { type: "object", properties: { name: { type: "string" }, given: { type: "string" }, when: { type: "string" }, then: { type: "string" },
        run: { type: "string", description: "optional shell command that demonstrates this example and exits 0 on success; omit unless you are confident it runs as-is from the project root" } }, required: ["name", "given", "when", "then"] } },
        children: { type: "array", items: { $ref: "#/$defs/node" } },
      },
      required: ["kind", "title", "spec"],
    },
  },
};

export function proposePrompt(brainDump: string, existingTree: string, parentTitle: string | null, repoSummary: string | null = null): string {
  return `You are turning a human's brain-dump into a tree of nodes for an agent dev kit.\n\nTwo node kinds: **intent** nodes group (title + one-paragraph spec, children); **behavior** nodes are leaves that own code (title, precise spec, 1–4 examples as given/when/then). Rules:\n- Group siblings under intent nodes wherever that makes the tree easier to read; do not flatten everything to one level.\n- Behavior specs are contracts: inputs, outputs, errors, limits. Concrete enough that an agent can implement without asking questions, no larger than the brain-dump asks for.\n- Examples are observable behavior, never test code.\n- deps: list titles of sibling behaviors that must exist first (e.g. "login" before "reset password").\n- Do not repeat nodes that already exist in the tree below; propose only what is new.\n${parentTitle ? `- The new nodes will be placed under the existing intent node "${parentTitle}".\n` : ""}\n${existingTree ? `## Existing tree\n\n${existingTree}\n\n` : ""}${repoSummary ? `## Repository overview (file: exported symbols)\n\n${repoSummary}\n\n` : ""}## Brain-dump\n\n${brainDump}\n\n${repoSummary ? "Do not modify anything." : "You may read the repository to understand conventions, but do not modify anything."} Return the tree as JSON matching the schema.`;
}

/** One file's behaviors. Symbols are referenced by the bracketed index shown in the prompt, never by key: the
 *  mapping back to symbol keys is done in code, so a behaviour can never anchor a symbol that was not offered. */
export const FILE_SCHEMA = {
  type: "object",
  properties: {
    behaviors: { type: "array", items: { type: "object", properties: {
      title: { type: "string" }, spec: { type: "string" },
      symbols: { type: "array", items: { type: "integer" }, description: "the bracketed indexes of the symbols this behavior owns" },
      examples: { type: "array", items: { type: "object", properties: { name: { type: "string" }, given: { type: "string" }, when: { type: "string" }, then: { type: "string" },
        run: { type: "string", description: "optional shell command that demonstrates this example and exits 0 on success; omit unless you are confident it runs as-is from the project root" } }, required: ["name", "given", "when", "then"] } },
    }, required: ["title", "spec", "symbols"] } },
  },
  required: ["behaviors"],
};

export const FOLDER_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, spec: { type: "string" } },
  required: ["title", "spec"],
};

export interface DeriveSymbol { idx: number; key: string; kind: string; name: string; container: string; file: string; sig: string; doc: string; source?: string }

/** Group one file's unowned symbols into behaviors. The scope is a single file, so the whole file usually fits. */
export function filePrompt(file: string, symbols: DeriveSymbol[]): string {
  const one = (s: DeriveSymbol) =>
    `[${s.idx}] ${s.kind} ${s.container ? s.container + "." : ""}${s.name}` +
    (s.doc ? `\n  doc: ${oneLine(s.doc, 200)}` : "") +
    (s.source ? `\n\n\`\`\`\n${s.source}\n\`\`\`\n` : s.sig ? `\n  ${oneLine(s.sig, 160)}` : "");
  return `You are deriving behavior nodes from existing code. Scope: the single file \`${file}\`.

Group the symbols below into **behavior** nodes: each is one user-observable behavior, with a title, a precise spec of what the code does, and 1-3 examples as given/when/then describing observable behavior.

Rules:
- Every symbol must be owned by exactly one behavior. Refer to symbols by their bracketed index, in the \`symbols\` array.
- Group by what the code does, not by name similarity. Symbols that collaborate on one job belong together; a symbol that does a big job alone is its own behavior.
- Prefer few, meaningful behaviors over one per symbol. A file that does one thing is one behavior.
- Write the spec from the code you are shown, not from the symbol's name. State only what the code actually does - no capability it does not have, no file or format it does not reference. If a symbol's source is not shown, describe it only as far as its signature supports.
- An example may carry a \`run\`: a shell command, executed from the project root, that demonstrates it and exits non-zero on failure. Add one only when you are confident it works as written against this repo; an example with no \`run\` is documentation, and that is fine.

## Symbols in \`${file}\`

${symbols.map(one).join("\n")}

Do not use tools. Return JSON matching the schema.`;
}

/** Name a folder from the children already derived under it. No source: this call is about the level above the code. */
export function folderPrompt(folder: string, children: { kind: string; title: string; spec: string }[], files: string[]): string {
  return `Name and describe one folder of a codebase, as an **intent** node: a title, and a one-paragraph spec saying what this area of the project is for and what it does.

Write it as orientation for someone deciding whether to look inside. Summarize the parts below rather than listing them, and stay at this level of abstraction - do not describe individual functions.

## Folder \`${folder || "."}\`

${files.length ? `Files: ${files.join(", ")}\n\n` : ""}## What is already described inside it

${children.length ? children.map((c) => `- [${c.kind}] ${c.title}: ${oneLine(c.spec, 240)}`).join("\n") : "(nothing yet)"}

Do not use tools. Return JSON matching the schema.`;
}

export const BEHAVIOR_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" }, spec: { type: "string" },
    examples: { type: "array", items: { type: "object", properties: { name: { type: "string" }, given: { type: "string" }, when: { type: "string" }, then: { type: "string" },
        run: { type: "string", description: "optional shell command that demonstrates this example and exits 0 on success; omit unless you are confident it runs as-is from the project root" } }, required: ["name", "given", "when", "then"] } },
  },
  required: ["title", "spec", "examples"],
};

export function behaviorPrompt(n: LenzNode, sources: { key: string; source: string }[], parent: LenzNode | null): string {
  return `You are rewriting one **behavior** node of a software project graph from its current code. Produce a title, a precise spec of what the code observably does, and 1–3 examples (given/when/then describing observable behavior). An example may carry a \`run\`: a shell command, executed from the project root, that demonstrates it and exits non-zero on failure - add one only when you are confident it works as written; omitting it is fine. Describe the code as it is now, not as it was described before.${parent ? `\n\nParent intent: ${parent.title} — ${oneLine(parent.spec, 300)}` : ""}\n\n## Previous description (may be stale)\n\n${nodeToYamlForPrompt(n)}\n\n## Anchored symbols\n\n${sources.map((s) => `### ${s.key}\n\n\`\`\`\n${s.source.slice(0, 4000)}\n\`\`\``).join("\n\n")}\n\nDo not use tools. Return JSON matching the schema.`;
}

export function nodeToYamlForPrompt(n: LenzNode) { return YAML.stringify({ title: n.title, spec: n.spec, examples: n.examples }); }

export function summaryPrompt(n: LenzNode, parent: LenzNode | null, children: LenzNode[], out: { id: string; title: string; via: string[] }[], inn: { id: string; title: string; via: string[] }[]): string {
  const level = n.kind === "intent" ? (parent ? "a module inside " + parent.title : "a top-level area of the project") : "a single behavior";
  return `Write a short orientation summary (2–4 sentences, plain prose, no headings, no bullet lists) for one node of a software project graph. The reader is a human deciding where to look next. Stay at the abstraction level of this node (${level}): say what it is for, what it does in one breath, then how it connects — what it hands off to, and what it relies on. Reference other nodes ONLY with their id in double brackets, e.g. [[n_ab12cd]] — the UI turns these into links; never write their titles. Do not mention nodes that are not listed below. Do not restate the spec verbatim.

## This node
id: ${n.id}
kind: ${n.kind}
title: ${n.title}
spec: ${oneLine(n.spec, 900)}
${children.length ? `\n## Its parts (children, for context; do not link them individually unless essential)\n${children.map((c) => `- ${c.title}: ${oneLine(c.spec, 140)}`).join("\n")}\n` : ""}
## Hands off to / calls (link these)
${out.length ? out.map((o) => `- [[${o.id}]] ${o.title} — e.g. ${o.via.join("; ")}`).join("\n") : "(none known)"}

## Relies on / is called by (link these)
${inn.length ? inn.map((o) => `- [[${o.id}]] ${o.title} — e.g. ${o.via.join("; ")}`).join("\n") : "(none known)"}

Respond with the summary text only.`;
}
