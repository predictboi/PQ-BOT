// Close resolved LS-LMSR markets in the only safe order (run from a cloud session — needs ADMIN_SECRET_KEY, which
// never goes on the always-on server):
//   1. winners claim (traders + creators)   2. creator claims its trading fee   3. every holder reclaims its position
//   4. admin quest.closeLslmsrMarket — only when the market shows 0 open positions and 0 unclaimed fees
// Rent returns to the creator; the backend sweeps the vault residual.
//   node bin/close-markets.js [--quest 900033,900034] [--dry]
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { syncFromPlatform } from '../src/creator.js';
import { allMarkets } from '../src/state.js';
import { readMarket } from '../src/chain/read.js';
import { claimAll, claimCreatorFee, closePosition, claimWallets } from '../src/claims.js';
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
const wallets = claimWallets(); const out = [];
for (const m of markets) {
  const rec = { questId: m.questId, creator: m.creator, steps: [] }; out.push(rec);
  let ch = await readMarket(m.questId); if (!ch) { rec.result = 'already closed'; continue; }
  if (a.dry) { rec.result = { dry: true, openPositions: ch.openPositions, creatorFee: ch.accruedCreatorFee, platformFee: ch.accruedPlatformFee }; continue; }
  const c = await claimAll({ questIds: [m.questId] }); rec.steps.push({ claims: c.claimed.length, claimFailed: c.failed.length });
  if (ch.accruedCreatorFee > 0) { try { await claimCreatorFee(creatorByLabel(m.creator), m.questId); rec.steps.push({ creatorFee: ch.accruedCreatorFee }); } catch (e) { rec.steps.push({ creatorFeeError: e.message.slice(0, 120) }); } }
  const holders = new Set(); for (let p = 1; p <= 20; p++) { const r = await pq.trpcQuery(null, 'betting.listByQuest', { questId: m.questId, page: p, pageSize: 100 }); (r.data || []).forEach((b) => holders.add(b.walletAddress)); if (!r.hasMore) break; }
  for (const w of wallets.filter((x) => holders.has(x.address))) { try { await closePosition(w, m.questId); rec.steps.push({ closedPosition: w.label }); } catch (e) { rec.steps.push({ closePositionError: `${w.label}: ${e.message.slice(0, 100)}` }); } await sleep(1500); }
  await sleep(4000); ch = await readMarket(m.questId);
  if (ch.openPositions > 0 || ch.accruedCreatorFee > 0 || ch.accruedPlatformFee > 0) { rec.result = { blocked: true, openPositions: ch.openPositions, creatorFee: ch.accruedCreatorFee, platformFee: ch.accruedPlatformFee }; continue; }
  // right after the last position closes the backend can still simulate against the old state — retry with a pause
  for (let t = 0; t < 3 && rec.result == null; t++) {
    try { const admin = await pq.sessions.get(adminKp); await pq.trpc(admin, 'quest.closeLslmsrMarket', m.questId); rec.result = 'closed'; }
    catch (e) { if (t === 2) rec.result = { closeError: e.message.slice(0, 160) }; else await sleep(10000); }
  }
}
pj(out); process.exit(0);
