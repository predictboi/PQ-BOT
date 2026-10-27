// Organic volume trader (see src/organic.js): persona wallets that each follow a handful of favorite markets, Poisson
// arrivals shaped by a time-of-day curve, occasional bursts, human order sizes, holding before partial sells, and
// follow-up trades after a Polymarket move. Keeps price inside p* ± band; larger drift is oddsSync's job.
import path from 'node:path';
import { CONFIG, PATHS, CATEGORIES } from './config.js';
import { traderWallets } from './wallets.js';
import * as pq from './client/polyquest.js';
import { withLock } from './locks.js';
import { marketModel, isDecisive } from './oddsSync.js';
import { getSettings, liveMarkets, loadRuntime, patchRuntime, patchMarket } from './state.js';
import { createLogger, sleep, rnd, appendJsonl, readJsonl, withTimeout, round, clamp } from './util.js';
import { PERSONAS, assignPersonas, assignFavorites, popularity, rateAt, nextGapMs, orderSize, rng, hashStr } from './organic.js';

const log = createLogger('trader');
const TRADES = path.join(PATHS.reports, 'trades.jsonl');
const DAY = 86400000;
const pick = (items, weight) => { const tot = items.reduce((a, x) => a + weight(x), 0); let u = Math.random() * tot; for (const x of items) { u -= weight(x); if (u <= 0) return x; } return items[items.length - 1]; };

export class VolumeTrader {
  constructor({ onTrade } = {}) { this.onTrade = onTrade; this.running = false; this.stats = { n: 0, ok: 0, fail: 0, startedAt: null, lastTradeAt: null, lastError: null }; this.odds = {}; this.queue = []; this.lastWallet = null; this.lastMarket = {}; this.lastPStar = {}; this.recent = {}; }
  /** Trades per market over the last 24h (from the trade log), used to spread volume to quiet markets. */
  loadRecent() { const since = Date.now() - DAY; this.recent = {}; for (const r of readJsonl(TRADES, { limit: 5000 })) if (r.ok && new Date(r.t).getTime() >= since) this.recent[r.questId] = (this.recent[r.questId] || 0) + 1; }
  get settings() { return getSettings().trader; }
  targets() { return loadRuntime().targets || {}; }
  /** p* for a market: last odds-sync target → manual target → opening ratio → null (then the current price is the anchor) */
  pStar(m) { const t = this.targets()[m.questId]; if (t?.pStar != null) return t.pStar; if (m.manual?.targetOdds != null) return Number(m.manual.targetOdds); if (m.openingRatios?.[0]) return Number(m.openingRatios[0]) / 100; return null; }
  /** Result effectively known (Polymarket closed or past decidedP): organic traders leave it; odds sync still aligns it. */
  decided(m) { const t = this.targets()[m.questId]; return !!t && (t.closed || isDecisive(t.pStar, this.settings.decidedP ?? 0.985)); }
  walletBalance(w) { const b = (loadRuntime().balances || []).find((x) => x.index === w.index); return b ? { sol: b.sol, usdp: b.usdp } : null; }

  /** Personas, today's favorites and today's active wallets (persisted in runtime.organic so restarts keep them). */
  plan(markets) {
    const day = Math.floor(Date.now() / DAY); const o = loadRuntime().organic || {};
    const personas = o.personas && Object.keys(o.personas).length === this.wallets.length ? o.personas : assignPersonas(this.wallets, CATEGORIES.map((c) => c.name));
    const favorites = assignFavorites(personas, markets, o.favorites || {}, { day }); // keeps yesterday's still-live favorites
    const active = this.wallets.filter((w) => rng(hashStr(w.label) + day * 977)() < PERSONAS[personas[w.label].type].dailyP).map((w) => w.label);
    this.org = { personas, favorites, active, day, held: o.held || {} };
    patchRuntime({ organic: { personas, favorites, favDay: day, active, held: this.org.held } });
  }

  /** Current odds from the chain (the backend state double-counts duplicated rows); queue follow-ups after a p* move. */
  async snap(markets) {
    const s = this.settings;
    for (const m of markets) {
      try { const p = (await marketModel(m.questId)).normPrices()[0]; this.odds[m.questId] = { p, at: Date.now() }; patchMarket(m.questId, { p: round(p, 4), pAt: new Date().toISOString() }); } catch { /* keep last */ }
      const ps = this.pStar(m); const prev = this.lastPStar[m.questId]; this.lastPStar[m.questId] = ps;
      if (ps != null && prev != null && Math.abs(ps - prev) >= s.followMove) {
        const oi = ps > prev ? 0 : 1; const n = 2 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k++) this.queue.push({ at: Date.now() + rnd(2, 15) * 60000, questId: m.questId, oi, follow: true });
        log.info(`p* moved on q${m.questId} ${round(prev, 3)} → ${round(ps, 3)}: ${n} follow-up trades queued`);
      }
    }
  }

  chooseWallet(questId = null) {
    const f = getSettings().funding; const o = this.org;
    let cands = this.wallets.filter((w) => o.active.includes(w.label) && w.label !== this.lastWallet);
    if (questId != null) { const fans = cands.filter((w) => (o.favorites[w.label] || []).includes(questId)); if (fans.length) cands = fans; }
    cands = cands.filter((w) => { const b = this.walletBalance(w); return !b || (b.usdp >= f.usdpMin && b.sol >= 0.01); });
    return cands.length ? pick(cands, (w) => PERSONAS[o.personas[w.label].type].activity) : null;
  }

  async execute(ev, markets) {
    const s = this.settings; const o = this.org; const byId = new Map(markets.map((m) => [m.questId, m]));
    const w = this.chooseWallet(ev.questId ?? null); if (!w) return { skipped: 'no-wallet' };
    let m = ev.questId != null ? byId.get(ev.questId) : null;
    if (!m) {
      const favs = (o.favorites[w.label] || []).map((q) => byId.get(q)).filter((x) => x && x.questId !== this.lastMarket[w.label]);
      if (!favs.length) return { skipped: 'no-favorite' };
      m = pick(favs, (x) => popularity(x) / (1 + 0.5 * (this.recent[x.questId] || 0))); // quiet markets catch up
    }
    const type = o.personas[w.label].type; const p = this.odds[m.questId]?.p ?? this.pStar(m) ?? 0.5; const ps = this.pStar(m) ?? p;
    let oi;
    if (p > ps + s.band) oi = 1; else if (p < ps - s.band) oi = 0;
    else if (ev.oi != null) oi = ev.oi;
    else oi = Math.random() < clamp(0.5 + (ps - p) * 4, 0.2, 0.8) ? 0 : 1;
    const key = `${w.label}:${m.questId}:${oi}`; const h = o.held[key] || { amt: 0, at: 0 };
    const ageDays = m.createdAt ? (Date.now() - new Date(m.createdAt).getTime()) / DAY : 99;
    const sellP = ageDays < 3 ? s.sellP / 2 : s.sellP; // new markets: mostly buying
    let kind = 'BUY'; let spent = orderSize(type);
    if (!ev.follow && h.amt >= 5 && Date.now() - h.at >= s.minHoldMin * 60000 && Math.random() < sellP) { kind = 'SELL'; spent = Math.min(Math.floor(h.amt), Math.max(1, Math.round(h.amt * rnd(0.25, 0.75)))); }
    const bal = this.walletBalance(w); if (kind === 'BUY' && bal) spent = Math.min(spent, Math.floor(bal.usdp * s.maxBuyFrac));
    if (spent < 1) return { skipped: 'tiny' };
    const answerId = oi === 0 ? m.yesAnswerId : m.noAnswerId; const outcome = oi === 0 ? 'YES' : 'NO';
    const rec = { t: new Date().toISOString(), questId: m.questId, wallet: w.label, persona: type, kind, outcome, spent, follow: !!ev.follow, burst: !!ev.burst, cover: !!ev.cover, p: round(p, 4), pStar: round(ps, 4) };
    try {
      const r = await withLock(w.address, () => withTimeout(pq.sessions.withSession(w.kp, (sess) => pq.trade(sess, w.kp, { questId: m.questId, answerId, spent, kind })), CONFIG.timeouts.trade + 15000, 'trade'));
      o.held[key] = { amt: Math.max(0, h.amt + (kind === 'BUY' ? spent : -spent)), at: kind === 'BUY' ? Date.now() : h.at };
      patchRuntime({ organic: { ...(loadRuntime().organic || {}), held: o.held } });
      this.stats.ok++; rec.ok = true; rec.verified = !!r?.verified; rec.dryRun = !!r?.dryRun;
    } catch (e) { this.stats.fail++; rec.ok = false; rec.error = (e.message || '').slice(0, 120); this.stats.lastError = rec.error; }
    this.stats.n++; this.stats.lastTradeAt = rec.t; this.lastWallet = w.label; this.lastMarket[w.label] = m.questId; if (rec.ok) this.recent[m.questId] = (this.recent[m.questId] || 0) + 1;
    appendJsonl(TRADES, rec); this.onTrade?.(rec);
    log.info(`#${this.stats.n} q${m.questId} ${w.label}(${type}) ${kind} ${outcome} ${spent}${ev.follow ? ' follow' : ''}${ev.burst ? ' burst' : ''}${ev.cover ? ' cover' : ''} ${rec.ok ? 'ok' : 'FAIL ' + rec.error}`);
    return rec;
  }

  async run({ shouldStop = () => false } = {}) {
    if (this.running) return; this.running = true; this.stats.startedAt = new Date().toISOString();
    this.wallets = traderWallets();
    let markets = []; let lastSnap = 0; let day = -1; let n = 0; let reloginAt = 0;
    const refresh = async () => { markets = liveMarkets().filter((m) => m.yesAnswerId && m.noAnswerId && !this.decided(m)); this.plan(markets); this.loadRecent(); await this.snap(markets); lastSnap = Date.now(); day = this.org.day; };
    try {
      await refresh();
      let nextAt = Date.now() + nextGapMs(rateAt(new Date(), this.settings));
      while (!shouldStop()) {
        const s = this.settings;
        if (Math.floor(Date.now() / DAY) !== day || Date.now() - lastSnap > s.snapMin * 60000) await refresh();
        if (!markets.length || !this.wallets.length) { await sleep(15000); continue; }
        const due = this.queue.filter((e) => e.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
        if (due) { this.queue.splice(this.queue.indexOf(due), 1); await this.execute(due, markets).catch((e) => log.error('trade error:', e.message)); n++; }
        else if (Date.now() >= nextAt) {
          // a share of arrivals goes to the quietest live market so every market keeps some activity
          let ev = {};
          if (Math.random() < (s.coverP ?? 0.25)) { const quiet = [...markets].sort((a, b) => (this.recent[a.questId] || 0) - (this.recent[b.questId] || 0) || Math.random() - 0.5)[0]; if (quiet) ev = { questId: quiet.questId, cover: true }; }
          await this.execute(ev, markets).catch((e) => log.error('trade error:', e.message)); n++;
          if (Math.random() < s.burstP) { const k = 2 + Math.floor(Math.random() * 4); for (let i = 0; i < k; i++) this.queue.push({ at: Date.now() + rnd(0.5, 6) * 60000, burst: true }); }
          nextAt = Date.now() + Math.max(s.minGapMs, nextGapMs(rateAt(new Date(), s)));
        }
        if (n - reloginAt >= 150) { reloginAt = n; for (const w of this.wallets) pq.sessions.invalidate(w.kp); }
        await sleep(Math.max(1000, Math.min(15000, nextAt - Date.now())));
      }
    } finally { this.running = false; }
  }
}

/** One synthetic trade on a given market (dashboard "test trade"). */
export async function tradeOnce({ questId, outcome = 'YES', spent = 20, walletIndex }) {
  const ws = traderWallets(); const w = walletIndex != null ? ws.find((x) => x.index === Number(walletIndex)) : ws[Math.floor(Math.random() * ws.length)];
  const m = liveMarkets().find((x) => Number(x.questId) === Number(questId)); if (!m) throw new Error('market not live/known');
  const answerId = outcome === 'YES' ? m.yesAnswerId : m.noAnswerId;
  const r = await withLock(w.address, () => pq.sessions.withSession(w.kp, (sess) => pq.trade(sess, w.kp, { questId, answerId, spent, kind: 'BUY' })));
  appendJsonl(TRADES, { t: new Date().toISOString(), questId, wallet: w.label, kind: 'BUY', outcome, spent, ok: true, manual: true, verified: !!r?.verified });
  return { wallet: w.label, ...r };
}
