// Close resolved LS-LMSR markets (run from a cloud session — needs ADMIN_SECRET_KEY, which never goes on the
// always-on server):
//   1. winners claim (traders + creators)   2. creator claims its trading fee (only the seeder can sign it)
//   3. admin quest.closeLslmsrMarket — the backend closes every open position (paying winnings + rent to holders),
//      claims the platform fee, sweeps the vault and closes the market.
//   node bin/close-markets.js [--quest 900033,900034] [--dry]
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { syncFromPlatform } from '../src/creator.js';
import { allMarkets } from '../src/state.js';
import { readMarket } from '../src/chain/read.js';
import { claimAll, claimCreatorFee } from '../src/claims.js';
import { creatorByLabel } from '../src/wallets.js';
import * as pq from '../src/client/polyquest.js';
import { sleep } from '../src/util.js';
import { parseArgs, pj, die } from './_cli.js';

const a = parseArgs();
const raw = (process.env.ADMIN_SECRET_KEY || '').trim(); if (!raw) die('ADMIN_SECRET_KEY not set (cloud session only)');
const bytes = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
const adminKp = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
await syncFromPlatform();
const only = a.quest ? new Set(String(a.quest).split(',').map(Number)) : null;
const markets = allMarkets().filter((m) => ['SUCCESS', 'REVOKE'].includes(m.status) && (!only || only.has(m.questId)));
const out = [];
for (const m of markets) {
  const rec = { questId: m.questId, creator: m.creator, steps: [] }; out.push(rec);
  let ch = await readMarket(m.questId); if (!ch) { rec.result = 'already closed'; continue; }
  if (a.dry) { rec.result = { dry: true, openPositions: ch.openPositions, creatorFee: ch.accruedCreatorFee, platformFee: ch.accruedPlatformFee }; continue; }
  const c = await claimAll({ questIds: [m.questId] }); rec.steps.push({ claims: c.claimed.length, claimFailed: c.failed.length });
  if (ch.accruedCreatorFee > 0) { try { await claimCreatorFee(creatorByLabel(m.creator), m.questId); rec.steps.push({ creatorFee: ch.accruedCreatorFee }); } catch (e) { rec.steps.push({ creatorFeeError: e.message.slice(0, 120) }); } }
  if (ch.accruedCreatorFee > 0) { await sleep(4000); ch = await readMarket(m.questId); if (ch.accruedCreatorFee > 0) { rec.result = { blocked: 'creator fee unclaimed', creatorFee: ch.accruedCreatorFee }; continue; } }
  // the backend can re-read the market before its own fee claim / position closes land and refuse — retry with a pause
  for (let t = 0; t < 3 && rec.result == null; t++) {
    try { const admin = await pq.sessions.get(adminKp); const r = await pq.trpc(admin, 'quest.closeLslmsrMarket', m.questId); rec.result = { closed: true, message: r?.message ?? r?.data?.message ?? null }; }
    catch (e) { if (t === 2) rec.result = { closeError: e.message.slice(0, 160) }; else await sleep(15000); }
  }
}
pj(out); process.exit(0);
