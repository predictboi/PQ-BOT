// Daily resolution check: Polymarket resolved → quest.updateStatus SUCCESS(finalAnswerId) / REVOKE via the market creator's session.
// NEVER resolves on-chain directly (lesson B6-11). Admin session is only a fallback if the platform denies the creator.
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import path from 'node:path';
import { CONFIG, PATHS } from './config.js';
import { creatorByLabel } from './wallets.js';
import * as pq from './client/polyquest.js';
import { marketById as pmMarket, resolutionOf } from './polymarket.js';
import { allMarkets, patchMarket, marketById } from './state.js';
import { createLogger, appendJsonl, sleep } from './util.js';

const log = createLogger('resolver');
const REPORT = path.join(PATHS.reports, 'resolver.jsonl');

async function doUpdate(questId, status, finalAnswerId) {
  const kp = creatorByLabel(marketById(questId)?.creator); // the wallet that created the quest
  try { return await pq.sessions.withSession(kp, (sess) => pq.updateStatus(sess, questId, status, finalAnswerId)); }
  catch (e) {
    const denied = e?.code === 'FORBIDDEN' || e?.code === 'UNAUTHORIZED';
    if (denied && CONFIG.adminSecretKey) {
      log.warn(`creator denied for quest ${questId} (${e.code}); retrying with ADMIN session`);
      const admin = Keypair.fromSecretKey(bs58.decode(CONFIG.adminSecretKey));
      return pq.sessions.withSession(admin, (sess) => pq.updateStatus(sess, questId, status, finalAnswerId));
    }
    throw e;
  }
}

/** Resolve one market: winner 'YES' | 'NO' | 'REVOKE'. */
export async function resolveMarket(questId, winner, { reason = 'manual' } = {}) {
  const m = marketById(questId); if (!m) throw new Error(`unknown market ${questId}`);
  const status = winner === 'REVOKE' ? 'REVOKE' : 'SUCCESS';
  const finalAnswerId = winner === 'YES' ? m.yesAnswerId : winner === 'NO' ? m.noAnswerId : undefined;
  if (status === 'SUCCESS' && !finalAnswerId) throw new Error('missing answer id');
  const r = await doUpdate(questId, status, finalAnswerId);
  patchMarket(questId, { status, finalAnswerId: finalAnswerId ?? null, resolvedAt: new Date().toISOString(), resolution: { winner, reason } });
  appendJsonl(REPORT, { t: new Date().toISOString(), questId, title: m.title, status, winner, reason });
  log.info(`quest ${questId} → ${status} (${winner}, ${reason})`);
  return r;
}

export async function checkAll() {
  const out = { checked: 0, resolved: [], pending: [], manual: [], errors: [] };
  for (const m of allMarkets()) {
    if (m.status !== 'APPROVED') continue;
    out.checked++;
    try {
      // platform may already have moved on
      const d = await pq.questDetail(m.questId).catch(() => null);
      if (d && d.status !== 'APPROVED') { patchMarket(m.questId, { status: d.status, finalAnswerId: d.finalAnswerId ?? null }); continue; }
      const ended = m.endDate && new Date(m.endDate) < new Date();
      if (m.polymarket?.id) {
        const pm = await pmMarket(m.polymarket.id); const r = resolutionOf(pm);
        if (r.state === 'resolved') { await resolveMarket(m.questId, r.winner, { reason: 'polymarket' }); out.resolved.push({ questId: m.questId, winner: r.winner }); await sleep(2000); }
        else if (r.state === 'voided') { await resolveMarket(m.questId, 'REVOKE', { reason: 'polymarket-voided' }); out.resolved.push({ questId: m.questId, winner: 'REVOKE' }); await sleep(2000); }
        else if (ended || pm.closed) { patchMarket(m.questId, { pendingResolution: true }); out.pending.push({ questId: m.questId, state: r.state }); }
      } else if (ended) { patchMarket(m.questId, { needsManual: true }); out.manual.push({ questId: m.questId, title: m.title }); }
    } catch (e) { out.errors.push({ questId: m.questId, error: e.message.slice(0, 160) }); log.error(`quest ${m.questId}:`, e.message.slice(0, 160)); }
  }
  return out;
}
