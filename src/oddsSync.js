// Hourly odds sync: for every live market mapped to Polymarket, move our normalized YES price toward Polymarket's,
// bounded by maxMove per run and maxSpend per market, split across 2–4 trader wallets. All trades = user flow.
import path from 'node:path';
import { CONFIG, PATHS } from './config.js';
import { traderWallets } from './wallets.js';
import * as pq from './client/polyquest.js';
import { LsLmsr, spendToReachPrice } from './lslmsr.js';
import { readMarket } from './chain/read.js';
import { yesProbability } from './polymarket.js';
import { withLock } from './locks.js';
import { getSettings, liveMarkets, isMapped, loadRuntime, patchRuntime, patchMarket } from './state.js';
import { createLogger, sleep, appendJsonl, round, clamp } from './util.js';

const log = createLogger('oddsSync');
const REPORT = path.join(PATHS.reports, 'odds-sync.jsonl');

/** Pure planning step (also used by tests): returns { skip, reason } or { outcome, i, spend, target, chunks }. */
export function planMove({ p, pStar, model, band, maxMove, maxSpend, walletsMin, walletsMax }) {
  const delta = pStar - p;
  if (Math.abs(delta) <= band) return { skip: true, reason: 'in-band', delta };
  const target = p + Math.sign(delta) * Math.min(Math.abs(delta), maxMove);
  const i = delta > 0 ? 0 : 1; const tgt = i === 0 ? target : 1 - target;
  const r = spendToReachPrice(model, i, tgt, { maxSpend });
  if (!r || r.spend < 1) return { skip: true, reason: 'no-spend', delta };
  const spend = Math.floor(r.spend);
  const k = clamp(Math.ceil(spend / 800), walletsMin, walletsMax);
  const base = Math.floor(spend / k); const chunks = Array.from({ length: k }, (_, j) => base + (j === 0 ? spend - base * k : 0)).filter((x) => x >= 1);
  return { skip: false, outcome: i === 0 ? 'YES' : 'NO', i, spend, target: round(target, 4), expectedAfter: round(i === 0 ? r.priceAfter : 1 - r.priceAfter, 4), capped: r.capped, chunks, delta };
}

/**
 * LS-LMSR model for a quest from the on-chain market account (read-only). The site's displayed odds match the chain;
 * backend `quest.lslmsrState` was null for weeks and, once it returned data, carried shares inflated by the duplicated
 * betting rows (bug 2), so it is not used for planning trades.
 */
export async function marketModel(questId) {
  const m = await readMarket(questId); if (!m) throw new Error('market account not found');
  return new LsLmsr({ alpha: m.alpha, q: m.q });
}

/** Pick k funded wallets: ones that follow this market (organic favorites) first, in random order, then the richest. */
function pickWallets(k, questId = null, exclude = new Set()) {
  const ws = traderWallets(); const rt = loadRuntime(); const bal = rt.balances || []; const fav = rt.organic?.favorites || {};
  const ranked = ws.map((w) => { const b = bal.find((x) => x.index === w.index); return { w, usdp: b?.usdp ?? 0, sol: b?.sol ?? 0, fan: (fav[w.label] || []).includes(questId) ? 1 : 0, r: Math.random() }; })
    .filter((x) => !exclude.has(x.w.index) && x.sol >= 0.01 && x.usdp >= 100).sort((a, b) => b.fan - a.fan || (a.fan ? a.r - b.r : b.usdp - a.usdp));
  return ranked.slice(0, k).map((x) => x.w);
}

export async function syncMarket(m, s) {
  const rec = { t: new Date().toISOString(), questId: m.questId, title: m.title };
  try {
    const model = await marketModel(m.questId);
    const p = model.normPrices()[0]; rec.pBefore = round(p, 4);
    let pStar, source;
    if (m.polymarket?.id) { const r = await yesProbability(m.polymarket); pStar = r.p; source = r.source; if (r.market?.closed) rec.pmClosed = true; }
    else if (m.manual?.targetOdds != null) { pStar = Number(m.manual.targetOdds); source = 'manual'; }
    if (pStar == null) { rec.skipped = 'no-target'; return rec; }
    rec.pTarget = round(pStar, 4); rec.source = source;
    const targets = loadRuntime().targets || {}; targets[m.questId] = { pStar: round(pStar, 4), source, at: rec.t }; patchRuntime({ targets });
    patchMarket(m.questId, { p: round(p, 4), pStar: round(pStar, 4), pAt: rec.t });
    const plan = planMove({ p, pStar, model, band: s.band, maxMove: s.maxMove, maxSpend: s.maxSpend, walletsMin: s.walletsMin, walletsMax: s.walletsMax });
    if (plan.skip) { rec.skipped = plan.reason; rec.delta = round(plan.delta, 4); return rec; }
    Object.assign(rec, { outcome: plan.outcome, spend: plan.spend, moveTarget: plan.target, expectedAfter: plan.expectedAfter, capped: plan.capped });
    const answerId = plan.i === 0 ? m.yesAnswerId : m.noAnswerId; if (!answerId) { rec.skipped = 'no-answer-id'; return rec; }
    const wallets = pickWallets(plan.chunks.length, m.questId); if (!wallets.length) { rec.skipped = 'no-funded-wallets'; return rec; }
    rec.wallets = []; rec.ok = 0; rec.fail = 0;
    for (let j = 0; j < plan.chunks.length; j++) {
      const w = wallets[j % wallets.length]; const spent = plan.chunks[j];
      try { await withLock(w.address, () => pq.sessions.withSession(w.kp, (sess) => pq.trade(sess, w.kp, { questId: m.questId, answerId, spent, kind: 'BUY' }))); rec.ok++; rec.wallets.push(`${w.label}:${spent}`); }
      catch (e) { rec.fail++; rec.wallets.push(`${w.label}:${spent}:FAIL`); log.error(`q${m.questId} ${w.label} ${spent} failed:`, e.message.slice(0, 120)); }
      await sleep(s.pauseMs + Math.random() * (s.chunkJitterMs || 0)); // separate traders, not one burst
    }
    if (!CONFIG.dryRun) { await sleep(2500); try { rec.pAfter = round((await marketModel(m.questId)).normPrices()[0], 4); patchMarket(m.questId, { p: rec.pAfter, pAt: new Date().toISOString() }); } catch { /* ignore */ } }
    log.info(`q${m.questId} ${rec.pBefore} → ${rec.pTarget} (${source}) buy ${plan.outcome} ${plan.spend} → after ${rec.pAfter ?? '?'} (${rec.ok} ok / ${rec.fail} fail)`);
  } catch (e) { rec.error = e.message.slice(0, 160); log.error(`q${m.questId} sync error:`, e.message.slice(0, 160)); }
  finally { appendJsonl(REPORT, rec); }
  return rec;
}

export async function syncAll() {
  const s = getSettings().oddsSync; const markets = liveMarkets().filter((m) => isMapped(m) || m.manual?.targetOdds != null);
  const results = []; const order = [...markets].sort(() => Math.random() - 0.5);
  const gapMs = ((s.spreadMin || 0) * 60000 * 2) / Math.max(1, order.length); // spread the run over ~spreadMin minutes
  for (const m of order) { results.push(await syncMarket(m, s)); if (gapMs) await sleep(Math.random() * gapMs); }
  const moved = results.filter((r) => r.spend), inBand = results.filter((r) => r.skipped === 'in-band').length;
  const summary = { markets: markets.length, inBand, moved: moved.length, spent: moved.reduce((a, r) => a + (r.spend || 0), 0), errors: results.filter((r) => r.error).length, results };
  patchRuntime({ lastOddsSync: { t: new Date().toISOString(), markets: summary.markets, inBand, moved: summary.moved, spent: summary.spent, errors: summary.errors } });
  return summary;
}
