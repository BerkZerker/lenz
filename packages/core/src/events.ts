import { EventEmitter } from "node:events";

export type EventName = "node.updated" | "node.deleted" | "run.event" | "run.updated" | "lock.changed" | "drift.detected" | "structure.synced" | "staging.changed" | "log";
export interface LenzEvent { type: EventName; at: string; data: any }

export class EventBus extends EventEmitter {
  history: LenzEvent[] = [];
  publish(type: EventName, data: any) {
    const ev: LenzEvent = { type, at: new Date().toISOString(), data };
    this.history.push(ev);
    if (this.history.length > 2000) this.history.splice(0, 500);
    this.emit("event", ev);
    this.emit(type, ev);
  }
}
