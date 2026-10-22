// On-chain READ helpers only (balances, LS-LMSR market account decode). No program instructions are built here.
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { CONFIG } from '../config.js';
import { withTimeout } from '../util.js';

let _conn;
export function connection() { if (!_conn) _conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed' }); return _conn; }
export const PROGRAM_ID = new PublicKey(CONFIG.programId);
export const USDP_MINT = new PublicKey(CONFIG.usdpMint);

export async function rpcHealth() {
  try { const slot = await withTimeout(connection().getSlot('finalized'), CONFIG.timeouts.rpc, 'getSlot'); return { ok: true, slot, url: CONFIG.rpcIsFallback ? 'public fallback' : 'configured' }; }
  catch (e) { return { ok: false, error: e.message, url: CONFIG.rpcIsFallback ? 'public fallback' : 'configured' }; }
}

export async function solBalance(address) {
  const lamports = await withTimeout(connection().getBalance(new PublicKey(address), 'confirmed'), CONFIG.timeouts.rpc, 'getBalance');
  return lamports / LAMPORTS_PER_SOL;
}
export const usdpAta = (owner) => getAssociatedTokenAddressSync(USDP_MINT, new PublicKey(owner), false);
export async function usdpBalance(address) {
  try { const r = await withTimeout(connection().getTokenAccountBalance(usdpAta(address), 'confirmed'), CONFIG.timeouts.rpc, 'getTokenAccountBalance'); return Number(r.value.uiAmount || 0); }
  catch (e) { if (/could not find account|Invalid param/i.test(e.message)) return 0; throw e; }
}
/** Batch balances for many addresses: [{ address, sol, usdp, hasAta }] (2 RPC calls per 100 addresses). */
export async function balances(addresses) {
  const conn = connection(); const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const solInfos = await withTimeout(conn.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)), 'confirmed'), CONFIG.timeouts.rpc, 'solInfos');
    const ataInfos = await withTimeout(conn.getMultipleAccountsInfo(chunk.map((a) => usdpAta(a)), 'confirmed'), CONFIG.timeouts.rpc, 'ataInfos');
    chunk.forEach((address, k) => {
      const sol = (solInfos[k]?.lamports || 0) / LAMPORTS_PER_SOL;
      let usdp = 0; const d = ataInfos[k]?.data;
      if (d && d.length >= 72) usdp = Number(new BN(d.subarray(64, 72), 'le').toString()) / 10 ** CONFIG.collateralDecimals; // SPL token account: amount u64 LE @64
      out.push({ address, sol, usdp, hasAta: !!ataInfos[k] });
    });
  }
  return out;
}

// ---- LS-LMSR market account (read-only decode, ported from tools/solana-lslmsr-test/src/client.js) ----
const ACC = { registry: '2fae6ef6b8b6fcda', collateral: '07acee403d1a7601', market: 'dbbed53700e3c69a' };
export function questionId(questId) { const b = Buffer.alloc(32); b.writeBigUInt64LE(BigInt(questId)); return b; }
export const marketPda = (qid) => PublicKey.findProgramAddressSync([Buffer.from('market'), qid], PROGRAM_ID)[0];
export const vaultPda = (market) => PublicKey.findProgramAddressSync([Buffer.from('vault'), market.toBuffer()], PROGRAM_ID)[0];

export function decodeAccount(data) {
  const disc = data.subarray(0, 8).toString('hex'); let a = 8;
  const pk = () => { const k = new PublicKey(data.subarray(a, a + 32)); a += 32; return k; };
  const bytes = (n) => { const r = Buffer.from(data.subarray(a, a + n)); a += n; return r; };
  const u = (n) => { const r = new BN(data.subarray(a, a + n), 'le'); a += n; return r; };
  const u8 = () => data[a++];
  if (disc === ACC.registry) return { kind: 'registry', owner: pk(), minimum_seed_usd_wad: u(16), min_alpha_wad: u(16), max_alpha_wad: u(16), market_count: u(8), bump: u8() };
  if (disc === ACC.collateral) { const mint = pk(), decimals = u8(), mode = u8(), fixed = u(16), feed = pk(), hasFeed = u8(), feedId = bytes(32), maxAge = u(8), maxConf = u(16); return { kind: 'collateral', mint, decimals, pricing_mode: mode === 0 ? 'pegged' : 'custom', fixed_price_usd_wad: fixed, price_feed: hasFeed ? feed : null, price_feed_id: feedId, max_price_age_seconds: maxAge, max_confidence_ratio_wad: maxConf, is_active: u8() === 1, bump: u8() }; }
  if (disc === ACC.market) {
    const admin = pk(), resolverKey = pk(), hasResolver = u8(), seeder = pk(), collateral_mint = pk(), collateral_decimals = u8(), wad_per_unit = u(16), vault = pk(), question_id = bytes(32), outcome_count = u8(), alpha_wad = u(16);
    const outcome_shares_wad = Array.from({ length: 8 }, () => u(16)), initial_outcome_shares_units = Array.from({ length: 8 }, () => u(8));
    const seed_collateral_units = u(8), max_seed_loss_units = u(8), is_paused = u8() === 1, is_resolved = u8() === 1, is_void = u8() === 1, winning_outcome = u8();
    return { kind: 'market', admin, resolver: hasResolver ? resolverKey : null, seeder, collateral_mint, collateral_decimals, wad_per_unit, vault, question_id, outcome_count, alpha_wad, outcome_shares_wad: outcome_shares_wad.slice(0, outcome_count), initial_outcome_shares_units: initial_outcome_shares_units.slice(0, outcome_count), seed_collateral_units, max_seed_loss_units, is_paused, is_resolved, is_void, winning_outcome, bump: u8(), vault_bump: u8() };
  }
  throw new Error('unknown LMSR account discriminator ' + disc);
}

/** Read a market's on-chain q/alpha (confirmed, so a just-landed trade is visible) → { q:[...], alpha, is_resolved, is_void, winning_outcome } or null if no account. */
export async function readMarket(questId) {
  const info = await withTimeout(connection().getAccountInfo(marketPda(questionId(questId)), 'confirmed'), CONFIG.timeouts.rpc, 'getAccountInfo');
  if (!info) return null;
  const m = decodeAccount(info.data);
  return { q: m.outcome_shares_wad.map((w) => Number(w.toString()) / 1e18), alpha: Number(m.alpha_wad.toString()) / 1e18, is_resolved: m.is_resolved, is_void: m.is_void, winning_outcome: m.winning_outcome, is_paused: m.is_paused };
}
