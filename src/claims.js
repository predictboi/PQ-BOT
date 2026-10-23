// Winnings claims after resolution — user flow only: betting.listClaimableByWallet → betting.createClaim {questId, answerId}
// → sign → betting.confirmClaim {bettingId, signedTx}. Runs for every trader and both creator wallets.
// Order matters: claims must happen BEFORE a market is ever closed (closing first could strand the payouts).
import path from 'node:path';
import { CONFIG, PATHS } from './config.js';
import { traderWallets, allWallets } from './wallets.js';
import * as pq from './client/polyquest.js';
import { withLock } from './locks.js';
import { createLogger, appendJsonl, sleep, withTimeout } from './util.js';

const log = createLogger('claims');
const REPORT = path.join(PATHS.reports, 'claims.jsonl');
const peel = (r) => r?.data ?? r;

/** Wallets that can hold winnings: all traders + CREATOR-role wallets (their seed top-up buys are betting rows). */
export const claimWallets = () => [...traderWallets(), ...allWallets().filter((w) => w.role === 'CREATOR')];

export async function claimableFor(sess, address) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await withTimeout(pq.trpcQuery(sess, 'betting.listClaimableByWallet', { walletAddress: address, page, pageSize: 50 }), CONFIG.timeouts.read, 'listClaimable');
    const arr = r?.data ?? []; out.push(...arr); if (!r?.hasMore || !arr.length) break;
  }
  return out;
}

/** Claim one (quest, answer) position for one wallet. answerId is required when the wallet holds several (e.g. a seeder's YES+NO). */
export async function claimQuest(w, sess, questId, answerId = null) {
  if (CONFIG.dryRun) { log.info(`DRY_RUN claim q${questId}${answerId ? ` a${answerId}` : ''} ${w.label}`); return { dryRun: true }; }
  const input = { questId: Number(questId) }; if (answerId != null) input.answerId = Number(answerId);
  const d = peel(await withTimeout(pq.trpc(sess, 'betting.createClaim', input), CONFIG.timeouts.trade, 'betting.createClaim'));
  const tx = d?.encodedTx ?? d?.transaction; // createClaim names it `transaction`
  if (!tx) throw new Error(`createClaim returned no transaction: ${JSON.stringify(d).slice(0, 160)}`);
  const bettingId = d.betting?.id ?? d.bettingId ?? d.id;
  const signedTx = pq.signEncodedTx(w.kp, tx);
  const c = peel(await withTimeout(pq.trpc(sess, 'betting.confirmClaim', { bettingId: Number(bettingId), signedTx }), CONFIG.timeouts.trade, 'betting.confirmClaim'));
  return { bettingId, confirm: c };
}

/** Claim everything claimable (optionally only the given quests) across all claim wallets. */
export async function claimAll({ questIds = null, pauseMs = 1500 } = {}) {
  const only = questIds ? new Set(questIds.map(Number)) : null; const out = { wallets: 0, claimed: [], failed: [] };
  for (const w of claimWallets()) {
    let items = [];
    try { items = await pq.sessions.withSession(w.kp, (sess) => claimableFor(sess, w.address)); } catch (e) { out.failed.push({ wallet: w.label, error: `list: ${e.message.slice(0, 120)}` }); continue; }
    const pos = new Map(); // one claim per (quest, answer)
    for (const b of items) { if (b.isClaimed || b.claimTxn) continue; /* the list still returns claimed rows */ const q = Number(b.questId ?? b.quest?.id); const a = b.answerId ?? b.answer?.id ?? null; if (q && (!only || only.has(q))) pos.set(`${q}:${a}`, { q, a }); }
    if (!pos.size) continue; out.wallets++;
    for (const { q, a } of pos.values()) {
      const rec = { t: new Date().toISOString(), wallet: w.label, questId: q, answerId: a };
      try { const r = await withLock(w.address, () => pq.sessions.withSession(w.kp, (sess) => claimQuest(w, sess, q, a))); Object.assign(rec, { ok: true, bettingId: r.bettingId ?? null }); out.claimed.push(rec); log.info(`claimed q${q} a${a} ${w.label}`); }
      catch (e) { Object.assign(rec, { ok: false, error: e.message.slice(0, 160) }); out.failed.push(rec); log.error(`claim q${q} a${a} ${w.label} failed:`, e.message.slice(0, 160)); }
      appendJsonl(REPORT, rec); await sleep(pauseMs);
    }
  }
  return out;
}

/** Creator fee for a resolved quest (creator flow): quest.createClaimFee {questId} → sign → quest.confirmClaimFee {questId, signedTx}. */
export async function claimCreatorFee(kp, questId) {
  if (CONFIG.dryRun) { log.info(`DRY_RUN claim fee q${questId}`); return { dryRun: true }; }
  return pq.sessions.withSession(kp, async (sess) => {
    const d = peel(await withTimeout(pq.trpc(sess, 'quest.createClaimFee', { questId: Number(questId) }), CONFIG.timeouts.trade, 'quest.createClaimFee'));
    const tx = d?.transaction ?? d?.encodedTx; if (!tx) throw new Error(`createClaimFee returned no transaction: ${JSON.stringify(d).slice(0, 160)}`);
    const signedTx = pq.signEncodedTx(kp, tx);
    const c = peel(await withTimeout(pq.trpc(sess, 'quest.confirmClaimFee', { questId: Number(questId), signedTx }), CONFIG.timeouts.trade, 'quest.confirmClaimFee'));
    appendJsonl(REPORT, { t: new Date().toISOString(), kind: 'creator-fee', questId: Number(questId), ok: true });
    return c;
  });
}

/** Reclaim a holder's position rent once its winnings are redeemed (user flow): betting.createClosePosition {questId} → sign → betting.confirmClosePosition {signedTx}. */
export async function closePosition(w, questId) {
  if (CONFIG.dryRun) { log.info(`DRY_RUN close position q${questId} ${w.label}`); return { dryRun: true }; }
  return pq.sessions.withSession(w.kp, async (sess) => {
    const d = peel(await withTimeout(pq.trpc(sess, 'betting.createClosePosition', { questId: Number(questId) }), CONFIG.timeouts.trade, 'betting.createClosePosition'));
    const tx = d?.transaction ?? d?.encodedTx; if (!tx) throw new Error(`createClosePosition returned no transaction: ${JSON.stringify(d).slice(0, 160)}`);
    const c = peel(await withTimeout(pq.trpc(sess, 'betting.confirmClosePosition', { signedTx: pq.signEncodedTx(w.kp, tx) }), CONFIG.timeouts.trade, 'betting.confirmClosePosition'));
    appendJsonl(REPORT, { t: new Date().toISOString(), kind: 'close-position', wallet: w.label, questId: Number(questId), ok: true });
    return c;
  });
}
