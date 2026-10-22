// Liquidity top-up for markets created with a smaller seed: the market's creator buys YES and NO through the normal
// betting user flow (betting.draftLslmsr → sign → betting.confirm) so that q scales uniformly by k.
// LS-LMSR cost is homogeneous of degree 1 (C(k·q) = k·C(q)) and prices depend only on q/Σq, so scaling q keeps the
// displayed odds and adds exactly (k−1)·C(q) of collateral. Cost is path-independent, so splitting into rounds of
// YES-then-NO buys only limits the temporary price swing between the two legs.
import { LsLmsr } from './lslmsr.js';
import { marketModel } from './oddsSync.js';
import { creatorByLabel } from './wallets.js';
import * as pq from './client/polyquest.js';
import { createLogger, round, sleep } from './util.js';

const log = createLogger('seed-topup');

/** Per-round target share vectors that add `add` USDP of collateral to a market with shares q (alpha fixed). */
export function topupTargets(q, alpha, add, rounds = 4) {
  const c0 = LsLmsr.cost(q, alpha); const k = (c0 + add) / c0;
  return { c0, k, targets: Array.from({ length: rounds }, (_, r) => q.map((x) => x * (1 + ((k - 1) * (r + 1)) / rounds))) };
}

/** Spend needed to raise outcome i of q to share count `to` (0 if already there). */
export function spendToShares(q, alpha, i, to) {
  if (q[i] >= to) return 0;
  const q2 = q.slice(); q2[i] = to;
  return LsLmsr.cost(q2, alpha) - LsLmsr.cost(q, alpha);
}

/** Plan only: the YES/NO spends per round assuming every buy lands exactly. */
export function planTopup(q, alpha, add, rounds = 4) {
  const { c0, k, targets } = topupTargets(q, alpha, add, rounds);
  let cur = q.slice(); const legs = [];
  for (const t of targets) for (const i of [0, 1]) { const spend = spendToShares(cur, alpha, i, t[i]); if (spend > 0) { legs.push({ i, spend }); cur = cur.slice(); cur[i] = t[i]; } }
  return { c0, k, legs, total: legs.reduce((a, l) => a + l.spend, 0), pricesBefore: LsLmsr.normalize(LsLmsr.prices(q, alpha)), pricesAfter: LsLmsr.normalize(LsLmsr.prices(cur, alpha)) };
}

/**
 * Execute a top-up for one market with its creator wallet. Re-reads the market state before every leg so fees or
 * concurrent trades are absorbed by later legs. market: { questId, creator, yesAnswerId, noAnswerId }.
 */
export async function topupMarket(market, add, { rounds = 4, minLeg = 1, pauseMs = 3000, dryRun = false } = {}) {
  const start = await marketModel(market.questId);
  const plan = planTopup(start.q, start.alpha, add, rounds);
  const out = { questId: market.questId, creator: market.creator || 'CREATOR', add, k: round(plan.k, 4), planned: round(plan.total, 2), pricesBefore: plan.pricesBefore.map((p) => round(p, 4)), legs: [] };
  if (dryRun) return { ...out, dryRun: true, plannedLegs: plan.legs.map((l) => ({ outcome: l.i === 0 ? 'YES' : 'NO', spend: round(l.spend, 2) })) };
  const kp = creatorByLabel(market.creator);
  const { targets } = topupTargets(start.q, start.alpha, add, rounds);
  for (const t of targets) {
    for (const i of [0, 1]) {
      const m = await marketModel(market.questId);
      const spend = Math.floor(spendToShares(m.q, m.alpha, i, t[i]) * 100) / 100;
      if (spend < minLeg) continue;
      const answerId = i === 0 ? market.yesAnswerId : market.noAnswerId;
      const r = await pq.sessions.withSession(kp, (sess) => pq.trade(sess, kp, { questId: market.questId, answerId, spent: spend, kind: 'BUY' }));
      out.legs.push({ outcome: i === 0 ? 'YES' : 'NO', spend, bettingId: r.betting?.id ?? null });
      log.info(`quest ${market.questId} ${out.creator} BUY ${i === 0 ? 'YES' : 'NO'} ${spend}`);
      await sleep(pauseMs);
    }
  }
  const end = await marketModel(market.questId);
  out.spent = round(out.legs.reduce((a, l) => a + l.spend, 0), 2);
  out.pricesAfter = end.normPrices().map((p) => round(p, 4));
  return out;
}
