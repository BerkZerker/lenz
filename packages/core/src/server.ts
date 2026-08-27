import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Core } from "./core.ts";

const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const err = (e: any, status = 400) => json({ error: String(e?.message ?? e) }, status);

export function startServer(core: Core, staticDir: string) {
  const routes: { m: string; re: RegExp; h: (req: Request, p: Record<string, string>, url: URL) => Promise<Response> | Response }[] = [];
  const on = (m: string, path: string, h: (typeof routes)[number]["h"]) => routes.push({ m, re: new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h });
  const body = async (req: Request) => { try { return await req.json(); } catch { return {}; } };

  on("GET", "/api/status", () => json(core.status()));
  on("GET", "/api/nodes", () => json(core.store.all()));
  on("POST", "/api/nodes", async (req) => { try { return json(core.createNode(await body(req))); } catch (e) { return err(e); } });
  on("GET", "/api/nodes/:id", (_r, p) => { const n = core.store.get(p.id); return n ? json({ ...n, run: core.runs.runningFor(p.id) }) : err("not found", 404); });
  on("PUT", "/api/nodes/:id", async (req, p) => { try { return json(core.putNode(p.id, await body(req))); } catch (e) { return err(e); } });
  on("DELETE", "/api/nodes/:id", (_r, p) => { core.deleteNode(p.id); return json({ ok: true }); });
  on("POST", "/api/nodes/:id/approve", (_r, p) => { try { return json(core.approve(p.id)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/reject", async (req, p) => { try { const b = await body(req); return json(core.reject(p.id, b.note ?? "", b.redispatch ?? true)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/dispatch", async (req, p) => { try { const b = await body(req); return json(core.dispatch(p.id, b.note)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/verify", async (_r, p) => { try { return json(await core.verify(p.id)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/reconstruct", (_r, p) => { void core.reconstruct(p.id).catch((e) => core.log(String(e), "error")); return json({ ok: true }); });
  on("POST", "/api/nodes/:id/drift", async (req, p) => { try { const b = await body(req); return json(core.resolveDrift(p.id, b.action)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/examples/:ex/mark", async (req, p) => { try { const b = await body(req); return json(core.markExample(p.id, p.ex, !!b.pass)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/anchors/assign", async (req, p) => { try { const b = await body(req); return json(core.assignAnchor(p.id, b.key, b.owner ?? null)); } catch (e) { return err(e); } });
  on("POST", "/api/nodes/:id/set", async (req, p) => { try { const b = await body(req); return json(core.nodeSet(p.id, b.path, b.value)); } catch (e) { return err(e); } });
  on("GET", "/api/tree", () => json(core.store.tree()));
  on("GET", "/api/relations", () => json(core.relations()));
  on("POST", "/api/nodes/:id/summarize", async (_r, p) => { try { return json(await core.summarize(p.id)); } catch (e) { return err(e); } });
  on("POST", "/api/summarize", async (req) => { const b = await body(req); void core.summarizeAll(!!b.force, (m) => core.log(m)).catch((e) => core.log(String(e), "warn")); return json({ started: true }); });
  on("GET", "/api/files", () => json(core.files()));
  on("GET", "/api/orphans", () => json(core.orphans()));
  on("GET", "/api/source", (_r, _p, url) => { const f = url.searchParams.get("file"); if (!f) return err("file required"); const r = core.fileSource(f); return r ? json(r) : err("not found", 404); });
  on("GET", "/api/nodes/:id/flow-entry", (_r, p) => json({ key: core.flowEntryFor(p.id) }));
  on("GET", "/api/flow", (_r, _p, url) => json(core.flow(url.searchParams.get("from") ?? undefined)));
  on("GET", "/api/nodes/:id/flow", (_r, p, url) => { const d = url.searchParams.get("dir") === "in" ? "in" : "out"; const f = core.nodeFlow(p.id, d); return f ? json(f) : err("not found", 404); });
  on("GET", "/api/flow/entries", () => json(core.entryNodes()));
  on("POST", "/api/flow/pin", async (req) => { const b = await body(req); core.idx.db.pinEntryPoint(b.key, b.pinned !== false); return json(core.flow()); });
  on("GET", "/api/symbols/:key/source", (_r, p) => json({ key: p.key, source: core.idx.symbolSource(decodeURIComponent(p.key)) }));
  on("GET", "/api/runs", () => json(core.runs.list()));
  on("GET", "/api/runs/:id", (_r, p) => { const r = core.runs.get(p.id); return r ? json({ ...r, events: core.bus.history.filter((e) => e.type === "run.event" && e.data.run === p.id).map((e) => e.data.event) }) : err("not found", 404); });
  on("POST", "/api/runs/:id/kill", (_r, p) => json({ ok: core.runs.kill(p.id) }));
  on("POST", "/api/runs/:id/approve", (_r, p) => { const r = core.runs.get(p.id); if (!r?.node) return err("run has no node"); try { return json(core.approve(r.node)); } catch (e) { return err(e); } });
  on("POST", "/api/runs/:id/reject", async (req, p) => { const r = core.runs.get(p.id); if (!r?.node) return err("run has no node"); const b = await body(req); try { return json(core.reject(r.node, b.note ?? "")); } catch (e) { return err(e); } });
  on("GET", "/api/locks", () => json({ locks: core.locks.list(), log: core.locks.log.slice(-200) }));
  on("POST", "/api/locks/acquire", async (req) => { const b = await body(req); return json(core.locks.acquire(b.file, b.run, (f) => core.runs.changedSymbolsInFile(f))); });
  on("POST", "/api/locks/release", async (req) => { const b = await body(req); return json({ ok: core.locks.release(b.file, b.run) }); });
  on("POST", "/api/locks/touch", async (req) => { const b = await body(req); core.locks.touch(b.file, b.run); return json({ ok: true }); });
  on("POST", "/api/locks/notices", async (req) => { const b = await body(req); return json({ notices: core.locks.takeNotices(b.run) }); });
  on("GET", "/api/staging", () => json(core.staging()));
  on("POST", "/api/staging/confirm", async () => json(await core.confirmStaging()));
  on("POST", "/api/staging/immediate", async (req) => { const b = await body(req); core.setImmediate(!!b.on); return json(core.staging()); });
  on("POST", "/api/propose", async (req) => { const b = await body(req); try { return json(await core.propose(b.text ?? "", b.parent ?? null)); } catch (e) { return err(e); } });
  on("POST", "/api/derive", async (req) => { const b = await body(req); try { const { started, scope } = core.deriveAll(b.reset ?? "none"); return json({ started, scope }); } catch (e) { return err(e, 409); } });
  on("POST", "/api/nodes/:id/derive", async (req, p) => { const b = await body(req); try { const r = await core.deriveNode(p.id, b.reset ?? "none"); return json("started" in r ? { started: r.started, scope: r.scope } : r); } catch (e) { return err(e); } });
  on("POST", "/api/index", async (req) => { const ev = await core.idx.indexAll((await body(req).catch(() => ({})))?.rebuild === true); core.idx.applyScip(); return json(ev); });
  on("GET", "/api/events/history", () => json(core.bus.history.slice(-300)));

  const sockets = new Set<any>();
  core.bus.on("event", (ev) => { const s = JSON.stringify(ev); for (const ws of sockets) try { ws.send(s); } catch {} });

  const server = Bun.serve({
    port: core.port,
    hostname: "127.0.0.1",
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/events") { if (server.upgrade(req)) return undefined as any; return new Response("ws only", { status: 400 }); }
      if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "*", "access-control-allow-headers": "*" } });
      for (const r of routes) {
        if (r.m !== req.method) continue;
        const m = url.pathname.match(r.re); if (!m) continue;
        try { return await r.h(req, (m.groups ?? {}) as any, url); } catch (e) { return err(e, 500); }
      }
      if (url.pathname.startsWith("/api/")) return err("no such route", 404);
      // static GUI
      let p = join(staticDir, url.pathname === "/" ? "index.html" : url.pathname);
      if (!existsSync(p)) p = join(staticDir, "index.html");
      if (!existsSync(p)) return new Response("GUI not built. Run `bun run build:gui` in the lenz repo.", { status: 503 });
      // index.html names hashed asset files; a cached copy pins the browser to a stale bundle after a rebuild
      return new Response(Bun.file(p), { headers: { "cache-control": p.endsWith(".html") ? "no-store" : "max-age=31536000, immutable" } });
    },
    websocket: {
      open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "hello", at: new Date().toISOString(), data: core.status() })); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });
  return server;
}
