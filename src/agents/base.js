// Minimal agent runtime: each role is an Agent with a schedule (cron or long-running loop), guarded execution,
// status/report tracking and an event stream for the dashboard. Supervisor composes them.
import { EventEmitter } from 'node:events';
import cron from 'node-cron';
import { createLogger, nowIso } from '../util.js';
import { recordAgentRun } from '../reporting.js';

export class Agent extends EventEmitter {
  /** @param {{ name:string, title:string, description:string, cron?:()=>string, loop?:boolean, run:(ctx)=>Promise<any>, summarize?:(r)=>any, enabled?:()=>boolean }} o */
  constructor(o) {
    super(); Object.assign(this, { name: o.name, title: o.title, description: o.description, cronExpr: o.cron, loop: !!o.loop, runFn: o.run, summarize: o.summarize || ((r) => r), enabledFn: o.enabled || (() => true) });
    this.log = createLogger(o.name);
    this.state = { status: 'idle', runs: 0, failures: 0, lastRunAt: null, lastDurationMs: null, lastResult: null, lastError: null, nextRunAt: null, queued: false, paused: false, startedAt: null };
    this.task = null; this.stopFlag = false; this.current = null;
  }
  get enabled() { return this.enabledFn(); }
  snapshot() { return { name: this.name, title: this.title, description: this.description, cron: this.cronExpr?.() || null, loop: this.loop, enabled: this.enabled, ...this.state }; }
  emitChange() { this.emit('change', this.snapshot()); }

  start() {
    if (this.loop) { if (this.enabled && !this.state.paused) this.runLoop(); return; }
    if (this.cronExpr) {
      const expr = this.cronExpr();
      if (!cron.validate(expr)) { this.log.error('invalid cron', expr); return; }
      this.task = cron.schedule(expr, () => { if (this.enabled && !this.state.paused) this.execute('cron'); }, { timezone: 'UTC' });
      this.state.nextRunAt = nextCron(expr);
    }
    this.emitChange();
  }
  stop() { this.stopFlag = true; this.task?.stop(); this.task = null; }
  pause() { this.state.paused = true; this.stopFlag = true; this.emitChange(); }
  resume() { this.state.paused = false; this.stopFlag = false; if (this.loop) this.runLoop(); this.emitChange(); }
  /** Run now (queued once if already running). */
  async trigger(reason = 'manual', params = {}) {
    if (this.loop) { if (!this.current) this.runLoop(); return { started: true }; }
    if (this.current) { this.state.queued = true; this.emitChange(); return { queued: true }; }
    if (params?.wait) return this.execute(reason, params);
    this.execute(reason, params); return { started: true }; // dashboard follows progress via SSE / history
  }

  async execute(reason, params = {}) {
    const t0 = Date.now(); this.state.status = 'running'; this.state.lastRunAt = nowIso(); this.emitChange();
    const rec = { t: this.state.lastRunAt, reason };
    try {
      const r = await (this.current = this.runFn({ agent: this, reason, params }));
      const summary = this.summarize(r);
      Object.assign(this.state, { status: 'idle', lastResult: summary, lastError: null, lastDurationMs: Date.now() - t0, runs: this.state.runs + 1 });
      rec.ok = true; rec.durationMs = this.state.lastDurationMs; rec.result = summary;
      return r;
    } catch (e) {
      Object.assign(this.state, { status: 'error', lastError: (e.message || String(e)).slice(0, 300), lastDurationMs: Date.now() - t0, runs: this.state.runs + 1, failures: this.state.failures + 1 });
      rec.ok = false; rec.durationMs = this.state.lastDurationMs; rec.error = this.state.lastError; this.log.error('run failed:', e);
      return { error: this.state.lastError };
    } finally {
      this.current = null; if (this.cronExpr) this.state.nextRunAt = nextCron(this.cronExpr());
      recordAgentRun(this.name, rec); this.emitChange();
      if (this.state.queued) { this.state.queued = false; setTimeout(() => this.execute('queued'), 1000); }
    }
  }
  async runLoop() {
    if (this.current) return; this.stopFlag = false; this.state.status = 'running'; this.state.startedAt = nowIso(); this.emitChange();
    const rec = { t: this.state.startedAt, reason: 'loop' };
    try { await (this.current = this.runFn({ agent: this, shouldStop: () => this.stopFlag || !this.enabled })); this.state.status = this.state.paused ? 'paused' : 'idle'; rec.ok = true; }
    catch (e) { this.state.status = 'error'; this.state.lastError = (e.message || String(e)).slice(0, 300); this.state.failures++; rec.ok = false; rec.error = this.state.lastError; this.log.error('loop crashed:', e); }
    finally { this.current = null; this.state.runs++; this.state.lastRunAt = nowIso(); rec.endedAt = nowIso(); recordAgentRun(this.name, rec); this.emitChange(); }
  }
}

/** Next fire time for a 5-field cron (UTC), minute resolution. */
export function nextCron(expr) {
  try {
    const [mi, ho, dom, mon, dow] = expr.trim().split(/\s+/);
    const match = (f, v) => f === '*' || f.split(',').some((p) => { const [range, step] = p.split('/'); const s = step ? Number(step) : 1; if (range === '*') return v % s === 0; const [a, b] = range.split('-').map(Number); if (b == null) return step ? v >= a && (v - a) % s === 0 : v === a; return v >= a && v <= b && (v - a) % s === 0; });
    const d = new Date(); d.setUTCSeconds(0, 0); d.setUTCMinutes(d.getUTCMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 32; i++) { if (match(mi, d.getUTCMinutes()) && match(ho, d.getUTCHours()) && match(dom, d.getUTCDate()) && match(mon, d.getUTCMonth() + 1) && match(dow, d.getUTCDay())) return d.toISOString(); d.setUTCMinutes(d.getUTCMinutes() + 1); }
  } catch { /* ignore */ }
  return null;
}
