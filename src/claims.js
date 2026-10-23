// Winnings claims after resolution — user flow only: betting.listClaimableByWallet → betting.createClaim {questId}
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

/** Claim one quest for one wallet. */
export async function claimQuest(w, sess, questId) {
  if (CONFIG.dryRun) { log.info(`DRY_RUN claim q${questId} ${w.label}`); return { dryRun: true }; }
  const d = peel(await withTimeout(pq.trpc(sess, 'betting.createClaim', { questId: Number(questId) }), CONFIG.timeouts.trade, 'betting.createClaim'));
  if (!d?.encodedTx) throw new Error(`createClaim returned no encodedTx: ${JSON.stringify(d).slice(0, 160)}`);
  const bettingId = d.betting?.id ?? d.bettingId ?? d.id;
  const signedTx = pq.signEncodedTx(w.kp, d.encodedTx);
  const c = peel(await withTimeout(pq.trpc(sess, 'betting.confirmClaim', { bettingId: Number(bettingId), signedTx }), CONFIG.timeouts.trade, 'betting.confirmClaim'));
  return { bettingId, confirm: c };
}

/** Claim everything claimable (optionally only the given quests) across all claim wallets. */
export async function claimAll({ questIds = null, pauseMs = 1500 } = {}) {
  const only = questIds ? new Set(questIds.map(Number)) : null; const out = { wallets: 0, claimed: [], failed: [] };
  for (const w of claimWallets()) {
    let items = [];
    try { items = await pq.sessions.withSession(w.kp, (sess) => claimableFor(sess, w.address)); } catch (e) { out.failed.push({ wallet: w.label, error: `list: ${e.message.slice(0, 120)}` }); continue; }
    const quests = [...new Set(items.map((b) => Number(b.questId ?? b.quest?.id)).filter((q) => q && (!only || only.has(q))))];
    if (!quests.length) continue; out.wallets++;
    for (const q of quests) {
      const rec = { t: new Date().toISOString(), wallet: w.label, questId: q };
      try { const r = await withLock(w.address, () => pq.sessions.withSession(w.kp, (sess) => claimQuest(w, sess, q))); Object.assign(rec, { ok: true, bettingId: r.bettingId ?? null }); out.claimed.push(rec); log.info(`claimed q${q} ${w.label}`); }
      catch (e) { Object.assign(rec, { ok: false, error: e.message.slice(0, 160) }); out.failed.push(rec); log.error(`claim q${q} ${w.label} failed:`, e.message.slice(0, 160)); }
      appendJsonl(REPORT, rec); await sleep(pauseMs);
    }
  }
  return out;
}
