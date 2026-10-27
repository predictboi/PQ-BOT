// Reports: hourly snapshots (reports/snapshots.jsonl), daily markdown summary, trade statistics, per-agent run logs.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, CATEGORIES } from './config.js';
import { allMarkets, liveMarkets, loadRuntime, getSettings } from './state.js';
import { readJsonl, appendJsonl, ensureDir, round, fmt } from './util.js';

const F = { trades: path.join(PATHS.reports, 'trades.jsonl'), odds: path.join(PATHS.reports, 'odds-sync.jsonl'), snapshots: path.join(PATHS.reports, 'snapshots.jsonl'), agents: (n) => path.join(PATHS.reports, 'agents', `${n}.jsonl`), daily: path.join(PATHS.reports, 'daily') };
export const REPORT_FILES = F;

export function tradeStats(hours = 24) {
  const since = Date.now() - hours * 3600000; const rows = readJsonl(F.trades, { limit: 20000 }).filter((r) => new Date(r.t).getTime() >= since);
  const ok = rows.filter((r) => r.ok); const byMarket = {}; const byWallet = {};
  for (const r of ok) { byMarket[r.questId] = (byMarket[r.questId] || 0) + r.spent; byWallet[r.wallet] = (byWallet[r.wallet] || 0) + 1; }
  const failByWallet = {}; for (const r of rows.filter((r) => !r.ok)) failByWallet[r.wallet] = (failByWallet[r.wallet] || 0) + 1;
  return { hours, n: rows.length, ok: ok.length, fail: rows.length - ok.length, successRate: rows.length ? round(ok.length / rows.length, 4) : null, volume: round(ok.reduce((a, r) => a + (r.spent || 0), 0), 2), byMarket, byWallet, failByWallet, last: rows.slice(-20) };
}

export function marketSummary() {
  const live = liveMarkets(); const band = 0.03; const byCat = {}; const targets = getSettings().categoryTargets;
  for (const c of CATEGORIES) byCat[c.name] = { target: Number(targets[c.name] ?? 0), live: live.filter((m) => Number(m.categoryId) === c.id).length };
  const compared = live.filter((m) => m.p != null && m.pStar != null);
  const inBand = compared.filter((m) => Math.abs(m.p - m.pStar) <= band).length;
  return { live: live.length, total: allMarkets().length, byCat, mapped: live.filter((m) => m.polymarket?.id).length, compared: compared.length, inBand, inBandPct: compared.length ? round(inBand / compared.length, 4) : null, pendingResolution: allMarkets().filter((m) => m.pendingResolution || m.needsManual).length };
}

export function buildSnapshot() {
  const rt = loadRuntime(); const t = tradeStats(24); const m = marketSummary();
  const snap = { t: new Date().toISOString(), markets: m.live, byCat: Object.fromEntries(Object.entries(m.byCat).map(([k, v]) => [k, v.live])), inBandPct: m.inBandPct, compared: m.compared, trades24h: t.n, ok24h: t.ok, fail24h: t.fail, successRate: t.successRate, volume24h: t.volume, sol: rt.totals?.sol ?? null, usdp: rt.totals?.usdp ?? null, funderSol: rt.balances?.find((b) => b.index === 0)?.sol ?? null, funderUsdp: rt.balances?.find((b) => b.index === 0)?.usdp ?? null, lastOddsSync: rt.lastOddsSync || null };
  appendJsonl(F.snapshots, snap);
  writeDaily(snap, t, m);
  return snap;
}
export const snapshots = (limit = 168) => readJsonl(F.snapshots, { limit });
export const agentRuns = (name, limit = 50) => readJsonl(F.agents(name), { limit });
export const recordAgentRun = (name, rec) => appendJsonl(F.agents(name), rec);
export const oddsSyncRecent = (limit = 100) => readJsonl(F.odds, { limit });

function writeDaily(snap, t, m) {
  ensureDir(F.daily); const day = snap.t.slice(0, 10); const file = path.join(F.daily, `${day}.md`);
  const lines = [
    `# Polyquest bot daily report — ${day}`, '', `_last update ${snap.t}_`, '',
    `## Markets`, `- live: **${m.live}** (mapped to Polymarket: ${m.mapped}) · in-band (|p−p*| ≤ 3%p): ${m.inBand}/${m.compared}` + (m.inBandPct != null ? ` (${(m.inBandPct * 100).toFixed(0)}%)` : ''),
    ...CATEGORIES.map((c) => `  - ${c.name}: ${m.byCat[c.name].live}/${m.byCat[c.name].target}`), '',
    `## Trading (24h)`, `- trades: ${t.n} · ok ${t.ok} · fail ${t.fail} · success ${t.successRate != null ? (t.successRate * 100).toFixed(1) + '%' : '-'}`, `- volume: ${fmt(t.volume)} USDP`, '',
    `## Treasury`, `- total SOL ${fmt(snap.sol, 4)} · total USDP ${fmt(snap.usdp)} · FUNDER ${fmt(snap.funderSol, 4)} SOL / ${fmt(snap.funderUsdp)} USDP`, '',
    `## Odds sync`, snap.lastOddsSync ? `- ${snap.lastOddsSync.t}: ${snap.lastOddsSync.markets} markets, ${snap.lastOddsSync.inBand} in band, ${snap.lastOddsSync.moved} moved, spent ${fmt(snap.lastOddsSync.spent)} USDP, trades ${snap.lastOddsSync.tradeOk ?? '?'} ok / ${snap.lastOddsSync.tradeFail ?? '?'} failed, errors ${snap.lastOddsSync.errors}` : '- (none yet)', '',
  ];
  fs.writeFileSync(file, lines.join('\n'));
}
