// Top up liquidity of live markets created with the old 15,000 USDP seed to a random seed in settings.creator.seedRange.
// The market's creator buys YES+NO through the betting user flow (see src/seedTopup.js). Prices stay put.
//   node bin/seed-topup.js --dry               plan only (no signing)
//   node bin/seed-topup.js [--quest 900045] [--rounds 4] [--base 15000]
//   node bin/seed-topup.js --restore --quest 900045     only re-align the odds to Polymarket (creator buys the cheap side)
// Every top-up ends on the mapped Polymarket YES price when there is one, else on the odds it started from.
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { syncFromPlatform, pickSeed } from '../src/creator.js';
import { topupMarket, restorePrice } from '../src/seedTopup.js';
import { yesProbability } from '../src/polymarket.js';
import { liveMarkets } from '../src/state.js';
import { creatorByLabel } from '../src/wallets.js';
import * as pq from '../src/client/polyquest.js';
import { appendJsonl } from '../src/util.js';
import { parseArgs, pj } from './_cli.js';

const a = parseArgs(); const base = Number(a.base || 15000); const rounds = Number(a.rounds || 4);
await syncFromPlatform();
let markets = liveMarkets().filter((m) => !m.seed || Number(m.seed) <= base);
if (a.quest) markets = markets.filter((m) => String(m.questId) === String(a.quest));

// already topped up = the creator already holds a bet row on that quest
const betQuests = {};
for (const label of new Set(markets.map((m) => m.creator || 'CREATOR'))) {
  const kp = creatorByLabel(label); const ids = new Set();
  for (let p = 1; p <= 10; p++) { const r = await pq.sessions.withSession(kp, (s) => pq.betsByWallet(s, kp.publicKey.toBase58(), { page: p, pageSize: 50 })); const arr = r?.data ?? []; arr.forEach((b) => ids.add(b.questId)); if (!r?.hasMore || !arr.length) break; }
  betQuests[label] = ids;
}

const pmYes = async (m) => { try { if (!m.polymarket?.id && !m.polymarket?.tokenIds?.length) return null; const r = await yesProbability(m.polymarket); return r?.p > 0 && r.p < 1 ? r.p : null; } catch { return null; } };
const out = [];
if (a.restore) {
  for (const m of markets.length ? markets : liveMarkets().filter((x) => String(x.questId) === String(a.quest))) { const t = await pmYes(m); if (t == null) { out.push({ questId: m.questId, skipped: 'no Polymarket price' }); continue; } try { out.push({ questId: m.questId, targetYes: t, leg: await restorePrice(m, t) }); } catch (e) { out.push({ questId: m.questId, error: e.message.slice(0, 200) }); } }
  pj({ restore: true, markets: out }); process.exit(0);
}
for (const m of markets) {
  const label = m.creator || 'CREATOR';
  if (betQuests[label]?.has(m.questId)) { out.push({ questId: m.questId, skipped: 'creator already has bets (topped up?)' }); continue; }
  const target = pickSeed(); const add = target - base;
  try { const targetYes = await pmYes(m); const r = await topupMarket(m, add, { rounds, dryRun: !!a.dry, targetYes }); out.push({ target, targetYes, ...r }); if (!a.dry) appendJsonl(path.join(PATHS.reports, 'seed-topup.jsonl'), { t: new Date().toISOString(), target, ...r }); }
  catch (e) { out.push({ questId: m.questId, target, error: e.message.slice(0, 200) }); }
}
pj({ base, count: out.length, totalPlanned: Math.round(out.reduce((s, x) => s + (x.planned || 0), 0)), markets: out });
