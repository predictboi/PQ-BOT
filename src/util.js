// Small shared helpers: timeouts, retries, JSON/JSONL files, logging with an in-memory ring buffer for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PATHS } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const round = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : x);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const daysFromNow = (d) => new Date(Date.now() + d * 86400000);
export const short = (s, n = 6) => (s ? `${String(s).slice(0, n)}…${String(s).slice(-4)}` : '');

/** Race a promise against a timeout so a stalled fetch/RPC becomes a catchable error. */
export function withTimeout(p, ms, label = 'op') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout:${label}:${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Retry an async fn with exponential backoff. */
export async function retry(fn, { tries = 3, delayMs = 1500, factor = 2, label = 'op', onError } = {}) {
  let last;
  for (let a = 0; a < tries; a++) {
    try { return await fn(a); } catch (e) {
      last = e; onError?.(e, a);
      if (a < tries - 1) await sleep(delayMs * factor ** a);
    }
  }
  throw Object.assign(new Error(`${label} failed after ${tries} tries: ${last?.message || last}`), { cause: last });
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
export function appendJsonl(file, obj) {
  try { ensureDir(path.dirname(file)); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch { /* best effort */ }
}
/** Read the last `limit` records of a JSONL file (newest last). */
export function readJsonl(file, { limit = 200 } = {}) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- logging: console + reports/bot.log + ring buffer (dashboard) + event stream (SSE) ----
const RING_MAX = 600;
const ring = [];
export const logEvents = new EventEmitter();
logEvents.setMaxListeners(100);
export const recentLogs = (n = 200) => ring.slice(-n);

export function createLogger(name) {
  const emit = (level, parts) => {
    const msg = parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    const rec = { t: nowIso(), level, agent: name, msg };
    ring.push(rec); if (ring.length > RING_MAX) ring.shift();
    const line = `${rec.t} [${level}] ${name}: ${msg}`;
    if (level === 'error') console.error(line); else console.log(line);
    try { ensureDir(PATHS.reports); fs.appendFileSync(path.join(PATHS.reports, 'bot.log'), line + '\n'); } catch { /* ignore */ }
    logEvents.emit('log', rec);
  };
  return {
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    debug: (...a) => { if (process.env.DEBUG) emit('debug', a); },
  };
}

/** Format a number with thousands separators and fixed decimals. */
export const fmt = (x, d = 2) => (Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }) : '-');
