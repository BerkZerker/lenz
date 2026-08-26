import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core, FanOutError, LockBroker, EventBus, extractJson, fanOutViolation } from "../src/index.ts";
import { judge, isSubset } from "../src/verify/examples.ts";
import { startServer } from "../src/server.ts";

const fixture = join(import.meta.dir, "../../structure/test/fixture");
let root: string; let core: Core; let server: ReturnType<typeof startServer>;
const PORT = 7399;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lgc-"));
  cpSync(fixture, root, { recursive: true });
  mkdirSync(join(root, ".lenzgraph/agents"), { recursive: true });
  // fake agent: emits stream-json, acquires a lock via the hook protocol, edits a file, registers an example run
  const fake = join(root, "fake-claude.sh");
  writeFileSync(fake, `#!/usr/bin/env bash
set -e
PROMPT=$(cat)
SETTINGS=""
while [ $# -gt 0 ]; do case "$1" in --settings) SETTINGS="$2"; shift;; esac; shift; done
echo '{"type":"system","subtype":"init","session_id":"sess-1","model":"fake"}'
if ! echo "$PROMPT" | grep -q "Output contract"; then echo '{"type":"result","subtype":"success","result":"This code hashes passwords.","session_id":"sess-1"}'; exit 0; fi
HOOK=$(python3 -c "import json,sys; print(json.load(open('$SETTINGS'))['hooks']['PreToolUse'][0]['hooks'][0]['command'])")
NODE=$(echo "$PROMPT" | grep -o 'node set n_[a-z0-9]*' | head -1 | awk '{print $3}')
# simulate a Write tool call through the PreToolUse hook
OUT=$(echo '{"tool_name":"Write","tool_input":{"file_path":"src/auth/hash.ts"},"cwd":"'"$PWD"'"}' | bash -c "$HOOK")
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"src/auth/hash.ts"}}]}}'
printf 'export function hashPassword(pw: string) { return "sha256:" + pw; }\\nexport function verifyPassword(pw: string, h: string) { return hashPassword(pw) === h; }\\n' > src/auth/hash.ts
sleep 1.2
$LENZ_CLI node set $NODE examples.ex_1.run "test -f src/auth/hash.ts"
$LENZ_CLI node set $NODE machine.run "grep -q verifyPassword src/auth/hash.ts"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'
echo '{"type":"result","subtype":"success","result":"implemented verifyPassword","total_cost_usd":0.01,"session_id":"sess-1"}'
`);
  chmodSync(fake, 0o755);
  writeFileSync(join(root, ".lenzgraph/agents/claude.yaml"), `command: ${fake} --settings {settings_file}\nevents: claude-stream-json\nhooks: claude-settings\n`);
  writeFileSync(join(root, ".lenzgraph/config.yaml"), "max_concurrent_runs: 2\nlock_cooldown: 2\nrun_timeout: 60\nexample_timeout: 10\n");
  core = new Core({ root, port: PORT, cli: [process.execPath, join(import.meta.dir, "../src/cli.ts")] });
  process.env.LENZ_CLI = `${process.execPath} ${join(import.meta.dir, "../src/cli.ts")} --root ${root} --port ${PORT}`;
  await core.start({ watch: true });
  server = startServer(core, join(root, "nostatic"));
});
afterAll(async () => { server.stop(true); await core.close(); rmSync(root, { recursive: true, force: true }); });

describe("nodes", () => {
  test("create/save/load with slug paths, fan-out cap, topo order", () => {
    const auth = core.createNode({ kind: "intent", title: "Auth" });
    const login = core.createNode({ kind: "behavior", title: "Login", parent: auth.id, spec: "users log in" });
    const reset = core.createNode({ kind: "behavior", title: "Reset password", parent: auth.id, spec: "reset", deps: [login.id] });
    expect(existsSync(join(root, ".lenzgraph/nodes/auth/reset-password.yaml"))).toBe(true);
    expect(core.store.topo([reset.id, login.id]).map((n) => n.id)).toEqual([login.id, reset.id]);
    for (let i = 0; i < 7; i++) core.createNode({ kind: "behavior", title: `b${i}`, parent: auth.id });
    expect(() => core.createNode({ kind: "behavior", title: "tenth", parent: auth.id })).toThrow(FanOutError);
    core.store.load();
    expect(core.store.get(reset.id)?.deps).toEqual([login.id]);
    for (const n of core.store.children(auth.id)) if (n.title.startsWith("b")) core.deleteNode(n.id);
  });
  test("rename moves the yaml file (git rename), id stable", () => {
    const auth = core.store.all().find((n) => n.title === "Auth")!;
    core.putNode(auth.id, { title: "Authentication" });
    expect(existsSync(join(root, ".lenzgraph/nodes/authentication.yaml"))).toBe(true);
    expect(existsSync(join(root, ".lenzgraph/nodes/authentication/reset-password.yaml"))).toBe(true);
    expect(core.store.get(auth.id)?.title).toBe("Authentication");
  });
  test("node set addresses examples by id and parses values", () => {
    const login = core.store.all().find((n) => n.title === "Login")!;
    core.putNode(login.id, { examples: [{ id: "ex_1", name: "happy", given: "g", when: "w", then: "t" }] });
    core.nodeSet(login.id, "examples.ex_1.run", "bun test -t ex_1");
    core.nodeSet(login.id, "machine.run", "bun test tests/");
    const n = core.store.get(login.id)!;
    expect(n.examples![0].run).toBe("bun test -t ex_1");
    expect(n.machine?.run).toBe("bun test tests/");
    expect(readFileSync(join(root, ".lenzgraph/nodes/authentication/login.yaml"), "utf8")).toContain("run: bun test -t ex_1");
  });
  test("spec edit stages the node; blast radius follows deps and refs", () => {
    const login = core.store.all().find((n) => n.title === "Login")!;
    const reset = core.store.all().find((n) => n.title === "Reset password")!;
    core.store.update(login.id, { status: "verified" });
    core.putNode(login.id, { spec: "users log in with email + password" });
    const s = core.staging();
    expect(s.staged).toEqual([login.id]);
    expect(s.blast).toContain(reset.id);
  });
});

describe("locks", () => {
  test("grant / deny while active / transfer after cooldown / notices", async () => {
    const bus = new EventBus(); let cd = 0.2;
    const lb = new LockBroker(bus, () => cd);
    expect(lb.acquire("a.ts", "r1").granted).toBe(true);
    expect(lb.acquire("a.ts", "r1").granted).toBe(true);
    const d = lb.acquire("a.ts", "r2"); expect(d.granted).toBe(false); expect(d.reason).toContain("held by run r1");
    await Bun.sleep(250);
    const t = lb.acquire("a.ts", "r2", () => ["foo"]); expect(t.granted).toBe(true); expect(t.transferred_from).toBe("r1");
    const n = lb.acquire("b.ts", "r1"); expect(n.notices[0]).toContain("run r2 took over a.ts"); expect(n.notices[0]).toContain("foo");
    lb.releaseAll("r2"); expect(lb.holder("a.ts")).toBeNull();
    expect(lb.log.map((e) => e.kind)).toEqual(["grant", "deny", "transfer", "grant", "release"]);
  });
});

describe("verification judges", () => {
  test("expect modes", () => {
    const out = { exit: 0, stdout: '{"a":1,"b":[1,2]}', stderr: "", timedOut: false };
    expect(judge({ id: "x", name: "x", expect: { mode: "exit0" } }, out).pass).toBe(true);
    expect(judge({ id: "x", name: "x", expect: { mode: "stdout_contains", value: '"a":1' } }, out).pass).toBe(true);
    expect(judge({ id: "x", name: "x", expect: { mode: "json_subset", value: { a: 1, b: [2] } } }, out).pass).toBe(true);
    expect(judge({ id: "x", name: "x", expect: { mode: "json_subset", value: { a: 2 } } }, out).pass).toBe(false);
    expect(judge({ id: "x", name: "x", expect: { mode: "manual" } }, out).pass).toBeNull();
    expect(isSubset({ x: { y: 1 } }, { x: { y: 1, z: 2 } })).toBe(true);
  });
  test("json extraction + fan-out validation of proposals", () => {
    expect(extractJson('blah ```json\n{"nodes":[]}\n``` more')).toEqual({ nodes: [] });
    expect(extractJson('text {"a":[1,2]} trailing')).toEqual({ a: [1, 2] });
    expect(fanOutViolation([{ title: "x", children: new Array(10).fill({ title: "c" }) }])).toContain("10 children");
    expect(fanOutViolation([{ title: "x" }])).toBeNull();
  });
});

describe("dispatch → build → verify (fake agent)", () => {
  test("run record, lock via hook, changed symbols, examples + machine executed, drift on manual edit", async () => {
    const auth = core.store.all().find((n) => n.title === "Authentication")!;
    const hashNode = core.createNode({ kind: "behavior", title: "Hash passwords", parent: auth.id, spec: "hashPassword returns a sha256-prefixed hash; verifyPassword compares.", examples: [{ id: "ex_1", name: "hash", given: "pw", when: "hash", then: "prefixed" }] });
    core.dispatch(hashNode.id);
    expect(core.store.get(hashNode.id)!.status).toBe("building");
    const runId = core.store.get(hashNode.id)!.last_run!;
    // wait for the run to end and verification to complete
    for (let i = 0; i < 100 && core.store.get(hashNode.id)!.status !== "built"; i++) await Bun.sleep(100);
    for (let i = 0; i < 50 && !core.store.get(hashNode.id)!.verification?.machine; i++) await Bun.sleep(100);
    const run = core.runs.get(runId)!;
    if (run.status !== "done") console.log("RUN ERROR:", run.error, readFileSync(join(root, ".lenzgraph/runs", runId, "events.jsonl"), "utf8").slice(0, 500));
    expect(run.status).toBe("done");
    expect(run.session_id).toBe("sess-1");
    expect(core.locks.log.some((e) => e.kind === "grant" && e.file === "src/auth/hash.ts" && e.run === runId)).toBe(true);
    expect(run.changed_symbols).toContain("src/auth/hash.ts##function#verifyPassword");
    expect(existsSync(join(root, ".lenzgraph/runs", runId, "prompt.md"))).toBe(true);
    expect(existsSync(join(root, ".lenzgraph/runs", runId, "events.jsonl"))).toBe(true);
    const result = JSON.parse(readFileSync(join(root, ".lenzgraph/runs", runId, "result.json"), "utf8"));
    expect(result.exit).toBe(0);
    const n = core.store.get(hashNode.id)!;
    expect(n.status).toBe("built");
    expect(n.anchors!.map((a) => a.name).sort()).toEqual(["hashPassword", "verifyPassword"]);
    expect(n.proposed_anchors!.length).toBeGreaterThanOrEqual(2);
    expect(n.examples![0].run).toBe("test -f src/auth/hash.ts");
    expect(n.verification!.examples!.pass).toBe(1);
    expect(n.verification!.machine!.ok).toBe(true);
    expect(core.idx.db.ownersOf("src/auth/hash.ts##function#verifyPassword")).toEqual([hashNode.id]);

    // approve → verified; then a manual edit drifts it
    core.approve(hashNode.id);
    expect(core.store.get(hashNode.id)!.status).toBe("verified");
    writeFileSync(join(root, "src/auth/hash.ts"), 'export function hashPassword(pw: string) { return "md5:" + pw; }\nexport function verifyPassword(pw: string, h: string) { return hashPassword(pw) === h; }\n');
    for (let i = 0; i < 50 && core.store.get(hashNode.id)!.status !== "drifted"; i++) await Bun.sleep(100);
    const d = core.store.get(hashNode.id)!;
    if (false) console.log("DEBUG anchors", JSON.stringify(d.anchors), "db:", JSON.stringify(core.idx.db.symbolsInFile("src/auth/hash.ts").map((s) => [s.key, s.body])), "synced:", core.bus.history.filter((e) => e.type === "structure.synced").map((e) => e.data.files.join(",") + "=" + e.data.changed.length).join(" / "), "file:", readFileSync(join(root, "src/auth/hash.ts"), "utf8").slice(0, 60), "runs:", core.runs.list().map((r) => r.id + ":" + r.kind + ":" + r.status + ":" + r.started_at).join(" "), "now", new Date().toISOString());
    expect(d.status).toBe("drifted"); expect(d.prev_status).toBe("verified"); expect(d.drift!.reasons[0]).toContain("hashPassword");
    core.resolveDrift(hashNode.id, "holds");
    expect(core.store.get(hashNode.id)!.status).toBe("verified");
    // anchors were refreshed to the new body → no drift on re-resolve
    expect(core.refreshAnchors(core.store.get(hashNode.id)!)).toEqual([]);
  }, 30000);

  test("HTTP API surface", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/tree`); expect(r.ok).toBe(true);
    const tree = await r.json(); expect(tree[0].title).toBe("Authentication");
    const o = await (await fetch(`http://127.0.0.1:${PORT}/api/orphans`)).json();
    expect(o.files.some((f: any) => f.file === "src/auth/hash.ts")).toBe(false);
    const f = await (await fetch(`http://127.0.0.1:${PORT}/api/flow?from=${encodeURIComponent("src/index.ts##function#main")}`)).json();
    expect(f.entries.length).toBe(1); expect(f.tree.children.length).toBeGreaterThan(0);
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/status`)).json();
    expect(st.nodes).toBeGreaterThan(0);
  });
});
