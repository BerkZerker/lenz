import type { EventBus } from "./events.ts";
import type { Lock, LockEvent } from "./types.ts";

export interface AcquireResult { granted: boolean; reason?: string; transferred_from?: string; notices: string[] }

/**
 * File-lock broker. Holder consent is inferred from activity: a lock held by another run is transferred
 * when the holder hasn't written the file within `cooldown` seconds; otherwise the request is denied.
 */
export class LockBroker {
  locks = new Map<string, Lock>();
  private notices = new Map<string, string[]>();
  log: LockEvent[] = [];
  constructor(private bus: EventBus, private cooldownSec: () => number) {}

  private record(e: Omit<LockEvent, "at">) {
    const ev = { at: new Date().toISOString(), ...e };
    this.log.push(ev); if (this.log.length > 1000) this.log.splice(0, 200);
    this.bus.publish("lock.changed", { event: ev, locks: this.list() });
  }
  list(): Lock[] { return [...this.locks.values()]; }
  heldBy(run: string) { return this.list().filter((l) => l.run === run).map((l) => l.file); }
  holder(file: string) { return this.locks.get(file)?.run ?? null; }

  acquire(file: string, run: string, changedSymbols?: (file: string) => string[]): AcquireResult {
    const now = Date.now();
    const notices = this.takeNotices(run);
    const cur = this.locks.get(file);
    if (!cur || cur.run === run) {
      this.locks.set(file, { file, run, acquired_at: cur?.acquired_at ?? now, last_write_at: now });
      if (!cur) this.record({ kind: "grant", file, run });
      return { granted: true, notices };
    }
    const idle = (now - cur.last_write_at) / 1000;
    if (idle < this.cooldownSec()) {
      const reason = `${file} is held by run ${cur.run}, active ${Math.round(idle)}s ago; retry later or work elsewhere`;
      this.record({ kind: "deny", file, run, reason });
      return { granted: false, reason, notices };
    }
    // transfer: previous holder is told on its next tool call
    this.locks.set(file, { file, run, acquired_at: now, last_write_at: now });
    const syms = changedSymbols?.(file) ?? [];
    this.pushNotice(cur.run, `run ${run} took over ${file} while you held it (idle ${Math.round(idle)}s)${syms.length ? `; symbols touched: ${syms.join(", ")}` : ""}. Re-read it before continuing.`);
    this.record({ kind: "transfer", file, run, from: cur.run });
    return { granted: true, transferred_from: cur.run, notices };
  }

  /** Called after a write completes (PostToolUse) to refresh holder activity. */
  touch(file: string, run: string) { const l = this.locks.get(file); if (l && l.run === run) l.last_write_at = Date.now(); }

  release(file: string, run: string) {
    const l = this.locks.get(file);
    if (l && l.run === run) { this.locks.delete(file); this.record({ kind: "release", file, run }); return true; }
    return false;
  }
  releaseAll(run: string, kind: "release" | "expire" = "release") {
    for (const [f, l] of [...this.locks]) if (l.run === run) { this.locks.delete(f); this.record({ kind, file: f, run }); }
    this.notices.delete(run);
  }
  pushNotice(run: string, msg: string) { const a = this.notices.get(run) ?? []; a.push(msg); this.notices.set(run, a); }
  takeNotices(run: string) { const a = this.notices.get(run) ?? []; this.notices.delete(run); return a; }
}
