// Volume trader: 30 wallets, round-robin over live markets, keeps price near p* (Polymarket) ± band with balanced two-way buys
// (plus occasional sells of held proxy). Inherits the soak24.mjs strategy; drift correction belongs to oddsSync.
import path from 'node:path';
import { CONFIG, PATHS } from './config.js';
import { traderWallets } from './wallets.js';
import * as pq from './client/polyquest.js';
import { withLock } from './locks.js';
import { getSettings, liveMarkets, loadRuntime, patchMarket } from './state.js';
import { createLogger, sleep, rnd, appendJsonl, withTimeout, round } from './util.js';

const log = createLogger('trader');
const TRADES = path.join(PATHS.reports, 'trades.jsonl');

export class VolumeTrader {
  constructor({ onTrade } = {}) { this.onTrade = onTrade; this.running = false; this.stats = { n: 0, ok: 0, fail: 0, startedAt: null, lastTradeAt: null, lastError: null }; this.odds = {}; this.held = {}; this.mi = 0; this.wi = 0; this.wallets = []; this.skippedWallets = new Set(); }
  get settings() { return getSettings().trader; }
  targets() { return loadRuntime().targets || {}; }
  /** p* for a market: last odds-sync target → opening ratio → 0.5 */
  pStar(m) { const t = this.targets()[m.questId]; if (t?.pStar != null) return t.pStar; if (m.manual?.targetOdds != null) return Number(m.manual.targetOdds); if (m.openingRatios?.[0]) return Number(m.openingRatios[0]) / 100; return 0.5; }

  async snapAll(markets) {
    if (!markets.length) return;
    try {
      const states = await pq.lslmsrStates(markets.map((m) => m.questId));
      for (const s of states || []) { this.odds[s.questId] = { p: s.prices?.[0], prices: s.prices, since: 0, at: Date.now() }; patchMarket(s.questId, { p: s.prices?.[0], pAt: new Date().toISOString() }); }
    } catch (e) { log.warn('snap failed:', e.message.slice(0, 100)); }
  }
  walletBalance(w) { const b = (loadRuntime().balances || []).find((x) => x.index === w.index); return b ? { sol: b.sol, usdp: b.usdp } : null; }

  async tick(markets) {
    const s = this.settings;
    const m = markets[this.mi % markets.length]; this.mi++;
    // next wallet with balance; underfunded wallets are skipped without spending a tick (partial funding = only a few wallets live)
    const f = getSettings().funding; let w = null;
    for (let k = 0; k < this.wallets.length && !w; k++) {
      const c = this.wallets[this.wi % this.wallets.length]; this.wi++;
      const bal = this.walletBalance(c);
      if (bal && (bal.usdp < f.usdpMin || bal.sol < 0.01)) this.skippedWallets.add(c.label); else w = c;
    }
    if (!w) return { skipped: 'low-balance' };
    this.skippedWallets.delete(w.label);
    const od = this.odds[m.questId]; const p = od?.p ?? this.pStar(m); const ps = this.pStar(m);
    // outcome choice: outside the band → push back toward p*; inside → random
    let oi; if (p > ps + s.band) oi = 1; else if (p < ps - s.band) oi = 0; else oi = Math.random() < 0.5 ? 0 : 1;
    const answerId = oi === 0 ? m.yesAnswerId : m.noAnswerId; const outcome = oi === 0 ? 'YES' : 'NO';
    const key = `${w.index}:${m.questId}:${oi}`; const h = this.held[key] || 0;
    const isFlux = Math.random() < s.fluxP; const [lo, hi] = isFlux ? s.flux : s.base;
    let spent = Math.round(rnd(lo, hi));
    let kind = (Math.random() < s.buyBias || h < lo) ? 'BUY' : 'SELL';
    if (kind === 'SELL') spent = Math.min(spent, Math.floor(h));
    if (spent < 1) return { skipped: 'tiny' };
    const rec = { t: new Date().toISOString(), questId: m.questId, wallet: w.label, kind, outcome, spent, flux: isFlux, p: round(p, 4), pStar: round(ps, 4) };
    try {
      const r = await withLock(w.address, () => withTimeout(pq.sessions.withSession(w.kp, (sess) => pq.trade(sess, w.kp, { questId: m.questId, answerId, spent, kind })), CONFIG.timeouts.trade + 15000, 'trade'));
      this.held[key] = h + (kind === 'BUY' ? spent : -spent);
      this.stats.ok++; rec.ok = true; rec.verified = !!r?.verified; rec.dryRun = !!r?.dryRun;
    } catch (e) { this.stats.fail++; rec.ok = false; rec.error = (e.message || '').slice(0, 120); this.stats.lastError = rec.error; }
    this.stats.n++; this.stats.lastTradeAt = rec.t;
    appendJsonl(TRADES, rec); this.onTrade?.(rec);
    if (od) od.since++;
    log.info(`#${this.stats.n} q${m.questId} ${w.label} ${kind} ${outcome} ${spent}${isFlux ? ' *flux' : ''} ${rec.ok ? 'ok' : 'FAIL ' + rec.error}`);
    return rec;
  }

  async run({ shouldStop = () => false } = {}) {
    if (this.running) return; this.running = true; this.stats.startedAt = new Date().toISOString();
    this.wallets = traderWallets();
    let markets = liveMarkets().filter((m) => m.yesAnswerId && m.noAnswerId);
    await this.snapAll(markets);
    let ticks = 0;
    try {
      while (!shouldStop()) {
        if (ticks % 60 === 0) { markets = liveMarkets().filter((m) => m.yesAnswerId && m.noAnswerId); if (ticks > 0) await this.snapAll(markets); }
        if (!markets.length || !this.wallets.length) { await sleep(15000); ticks++; continue; }
        const s = this.settings; const tickMs = Math.max(s.minTickMs, Math.round(3600000 / (s.tradesPerHourPerMarket * markets.length)));
        try { await this.tick(markets); } catch (e) { log.error('tick error:', e.message); }
        ticks++;
        if (ticks % s.snapEvery === 0) await this.snapAll(markets);
        if (ticks % s.reloginEvery === 0) for (const w of this.wallets) pq.sessions.invalidate(w.kp);
        await sleep(tickMs);
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
