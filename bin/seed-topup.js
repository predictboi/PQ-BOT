// Top up liquidity of live markets created with the old 15,000 USDP seed to a random seed in settings.creator.seedRange.
// The market's creator buys YES+NO through the betting user flow (see src/seedTopup.js). Prices stay put.
//   node bin/seed-topup.js --dry               plan only (no signing)
//   node bin/seed-topup.js [--quest 900045] [--rounds 4] [--base 15000]
import path from 'node:path';
import { PATHS } from '../src/config.js';
import { syncFromPlatform, pickSeed } from '../src/creator.js';
import { topupMarket } from '../src/seedTopup.js';
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

const out = [];
for (const m of markets) {
  const label = m.creator || 'CREATOR';
  if (betQuests[label]?.has(m.questId)) { out.push({ questId: m.questId, skipped: 'creator already has bets (topped up?)' }); continue; }
  const target = pickSeed(); const add = target - base;
  try { const r = await topupMarket(m, add, { rounds, dryRun: !!a.dry }); out.push({ target, ...r }); if (!a.dry) appendJsonl(path.join(PATHS.reports, 'seed-topup.jsonl'), { t: new Date().toISOString(), target, ...r }); }
  catch (e) { out.push({ questId: m.questId, target, error: e.message.slice(0, 200) }); }
}
pj({ base, count: out.length, totalPlanned: Math.round(out.reduce((s, x) => s + (x.planned || 0), 0)), markets: out });
