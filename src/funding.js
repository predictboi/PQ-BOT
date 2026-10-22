// FUNDER (index 0) → CREATOR / TRADER distribution, periodic top-up, sweep back. Plain transfers only.
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { CONFIG } from './config.js';
import { allWallets, hasMnemonic, FUNDER, FUNDER_INDEX, CREATOR_INDEX } from './wallets.js';
import { balances } from './chain/read.js';
import { transferSol, transferUsdp } from './chain/transfer.js';
import { getSettings, loadAddresses, patchRuntime, loadRuntime } from './state.js';
import { createLogger, round, sleep } from './util.js';

const log = createLogger('funding');

/** Wallet table (index/role/label/address). Prefers derived wallets; falls back to committed addresses.json. */
export function walletTable() {
  if (hasMnemonic()) return allWallets().map(({ index, role, label, address }) => ({ index, role, label, address }));
  return loadAddresses().wallets || [];
}

/** Fetch SOL/USDP for every wallet, cache in runtime.json, return rows. */
export async function refreshBalances() {
  const table = walletTable(); if (!table.length) return [];
  const rows = await balances(table.map((w) => w.address));
  const out = table.map((w, i) => ({ ...w, sol: round(rows[i].sol, 6), usdp: round(rows[i].usdp, 2), hasAta: rows[i].hasAta }));
  const totals = out.reduce((a, w) => ({ sol: a.sol + w.sol, usdp: a.usdp + w.usdp }), { sol: 0, usdp: 0 });
  patchRuntime({ balances: out, balancesAt: new Date().toISOString(), totals: { sol: round(totals.sol, 4), usdp: round(totals.usdp, 2) } });
  return out;
}
export const cachedBalances = () => loadRuntime().balances || [];

/** Compute transfers needed. mode 'initial' tops every wallet up to its init target; 'topup' only refills wallets under the minimum. */
export function plan(rows, mode = 'topup', opts = {}) {
  const f = { ...getSettings().funding, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)) };
  const funder = rows.find((w) => w.index === FUNDER_INDEX);
  const transfers = [];
  for (const w of rows) {
    if (w.index === FUNDER_INDEX) continue;
    // opts.traders = N limits an initial distribution to CREATOR + TRADER-01..N (partial Day-0 while funds are short)
    if (mode === 'initial' && Number.isFinite(f.traders) && w.role === 'TRADER' && w.index - CREATOR_INDEX > f.traders) continue;
    const solTarget = w.role === 'CREATOR' ? f.creatorSolInit : f.traderSolInit;
    const usdpTarget = w.role === 'CREATOR' ? f.creatorUsdpInit : f.traderUsdpInit;
    let sol = 0, usdp = 0;
    if (mode === 'initial') { sol = Math.max(0, solTarget - w.sol); usdp = Math.max(0, usdpTarget - w.usdp); }
    else { if (w.sol < f.solMin) sol = f.solTopup; if (w.usdp < f.usdpMin) usdp = f.usdpTopup; }
    sol = round(sol, 4); usdp = round(usdp, 2);
    if (sol >= 0.001) transfers.push({ to: w.address, label: w.label, kind: 'SOL', amount: sol, reason: mode });
    if (usdp >= 1) transfers.push({ to: w.address, label: w.label, kind: 'USDP', amount: usdp, reason: mode });
  }
  const needSol = transfers.filter((t) => t.kind === 'SOL').reduce((a, t) => a + t.amount, 0) + transfers.filter((t) => t.kind === 'USDP').length * 0.0021;
  const needUsdp = transfers.filter((t) => t.kind === 'USDP').reduce((a, t) => a + t.amount, 0);
  const availSol = Math.max(0, (funder?.sol || 0) - f.funderSolReserve), availUsdp = funder?.usdp || 0;
  return { transfers, needSol: round(needSol, 4), needUsdp: round(needUsdp, 2), funderSol: funder?.sol ?? 0, funderUsdp: funder?.usdp ?? 0, shortSol: round(Math.max(0, needSol - availSol), 4), shortUsdp: round(Math.max(0, needUsdp - availUsdp), 2) };
}

/** Execute a plan from FUNDER sequentially. Stops on insufficient funds. Returns { done:[], failed:[] }. */
export async function execute(p, { pauseMs = 1500 } = {}) {
  const funder = FUNDER(); const done = [], failed = [];
  let sol = Math.max(0, p.funderSol - getSettings().funding.funderSolReserve), usdp = p.funderUsdp;
  if (!p.transfers.length) return { done, failed, skipped: 'nothing-to-do' };
  if (sol < 0.003) { log.warn(`FUNDER has no spendable SOL (${p.funderSol}) — deposit first. Needed: ${p.needSol} SOL / ${p.needUsdp} USDP`); return { done, failed, skipped: 'funder-empty', needSol: p.needSol, needUsdp: p.needUsdp }; }
  if (p.shortSol > 0 || p.shortUsdp > 0) log.warn(`FUNDER short by ${p.shortSol} SOL / ${p.shortUsdp} USDP — executing what is affordable`);
  for (const t of p.transfers) {
    if (sol < 0.003 && (t.kind === 'SOL' || usdp <= 0)) { failed.push({ ...t, error: 'funder exhausted' }); continue; }
    try {
      if (t.kind === 'SOL') { if (t.amount > sol) throw new Error('funder SOL exhausted'); await transferSol(funder, t.to, t.amount); sol -= t.amount; }
      else { if (t.amount > usdp || sol < 0.003) throw new Error('funder USDP/SOL exhausted'); await transferUsdp(funder, t.to, t.amount); usdp -= t.amount; sol -= 0.0021; }
      done.push(t);
    } catch (e) { failed.push({ ...t, error: e.message.slice(0, 120) }); log.error(`${t.kind} ${t.amount} → ${t.label} failed:`, e.message.slice(0, 120)); }
    await sleep(pauseMs);
  }
  return { done, failed };
}

/** Initial distribution. opts: { traders, creatorSolInit, traderSolInit, creatorUsdpInit, traderUsdpInit } override the settings for this run only. */
export async function distributeInitial(opts = {}) { const rows = await refreshBalances(); const p = plan(rows, 'initial', opts); const r = await execute(p); await refreshBalances(); return { plan: p, ...r }; }
export async function topUp() { const rows = await refreshBalances(); const p = plan(rows, 'topup'); if (!p.transfers.length) return { plan: p, done: [], failed: [] }; const r = await execute(p); if (r.done.length) await refreshBalances(); return { plan: p, ...r }; }

/** Sweep USDP (and SOL above a small reserve) from traders (+creators) back to FUNDER. */
export async function sweep({ includeCreator = false, solReserve = 0.01 } = {}) {
  const rows = await refreshBalances(); const funderAddr = rows.find((w) => w.index === FUNDER_INDEX)?.address; const done = [], failed = [];
  for (const w of allWallets()) {
    if (w.index === FUNDER_INDEX || (w.role === 'CREATOR' && !includeCreator)) continue;
    const b = rows.find((r) => r.index === w.index); if (!b) continue;
    try {
      if (b.usdp >= 1) { await transferUsdp(w.kp, funderAddr, Math.floor(b.usdp * 100) / 100); done.push({ from: w.label, kind: 'USDP', amount: b.usdp }); await sleep(1200); }
      const solOut = round(b.usdp >= 1 ? b.sol - solReserve - 0.00001 : b.sol - solReserve, 6);
      if (solOut >= 0.002) { await transferSol(w.kp, funderAddr, solOut); done.push({ from: w.label, kind: 'SOL', amount: solOut }); await sleep(1200); }
    } catch (e) { failed.push({ from: w.label, error: e.message.slice(0, 120) }); }
  }
  await refreshBalances(); return { done, failed };
}

/** One-off: move SOL/USDP from a privileged wallet (bs58 secret from the env) into FUNDER. Plain transfer, never a platform action. */
async function fundFromKey(secretKey, envName, { sol = 0, usdp = 0 } = {}) {
  if (!secretKey) throw new Error(`${envName} not set`);
  const kp = Keypair.fromSecretKey(bs58.decode(secretKey));
  const to = FUNDER().publicKey.toBase58(); const out = { from: kp.publicKey.toBase58(), to };
  if (sol > 0) out.solSig = await transferSol(kp, to, sol);
  if (usdp > 0) out.usdpSig = await transferUsdp(kp, to, usdp);
  await refreshBalances(); return out;
}
export const fundFromMaster = (amounts) => fundFromKey(CONFIG.masterSecretKey, 'MASTER_SECRET_KEY', amounts);
export const fundFromAdmin = (amounts) => fundFromKey(CONFIG.adminSecretKey, 'ADMIN_SECRET_KEY', amounts);
