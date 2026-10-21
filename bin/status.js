// One-shot status: setup checklist, balances, markets by category, trade stats.
import { Supervisor } from '../src/agents/supervisor.js';
import { fmt } from '../src/util.js';
const S = new Supervisor(); const setup = await S.refreshSetup(); const snap = S.snapshot();
console.log(`Polyquest bot status — ${snap.now}${snap.dryRun ? ' (DRY_RUN)' : ''}`);
console.log('\nSetup checklist:'); for (const i of setup.items) console.log(`  ${i.ok ? '✅' : i.warn ? '⚠️ ' : '❌'} ${i.label} — ${i.detail}`);
console.log('\nMarkets:'); for (const [k, v] of Object.entries(snap.markets.byCat)) console.log(`  ${k.padEnd(10)} ${v.live}/${v.target}`);
console.log(`  live ${snap.markets.live} · mapped ${snap.markets.mapped} · in-band ${snap.markets.inBand}/${snap.markets.compared}`);
console.log(`\nTrades 24h: ${snap.trades.n} (ok ${snap.trades.ok}, fail ${snap.trades.fail}) volume ${fmt(snap.trades.volume)} USDP`);
if (snap.totals) console.log(`Treasury: ${fmt(snap.totals.sol, 4)} SOL / ${fmt(snap.totals.usdp)} USDP (as of ${snap.balancesAt})`);
process.exit(0);
