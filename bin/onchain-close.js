// Emergency on-chain wind-down of LS-LMSR markets, for when the Polyquest backend (and its DB) is gone.
// Owner-approved exception to the "user flow only" rule (Railway account banned Nov 2026, no backend to call).
// Per market, signed by the market admin/resolver (MASTER_SECRET_KEY):
//   1. resolve(outcome)              — skipped when already resolved
//   2. closePosition for every open position (any caller): winners get collateral + rent, losers get rent
//   3. claimFee (platform by the registry owner, creator by the seeder when we hold its key)
//   4. sweepResidual(vault balance) → seeder's token account (or the admin's)
//   5. closeMarket → market + vault rent to the seeder
// Outcome: --outcome map, else Polymarket result / current favourite, else the on-chain favourite.
//   node bin/onchain-close.js --dry [--quest 900175,900239]
//   node bin/onchain-close.js --quest 900175 [--outcome 900175=1]
import fs from 'node:fs';
import { Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { connection, PROGRAM_ID, decodeAccount, marketPda, questionId } from '../src/chain/read.js';
import { LsLmsr } from '../src/lslmsr.js';
import { wallet, walletIndices, CREATOR, CREATOR2 } from '../src/wallets.js';
import { allMarkets } from '../src/state.js';
import { yesProbability } from '../src/polymarket.js';
import { parseArgs, pj, die } from './_cli.js';

const a = parseArgs(); const DRY = !!a.dry;
const conn = connection(); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFrom = (raw) => { raw = (raw || '').trim(); if (!raw) return null; const b = raw.startsWith('[') ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw); return b.length === 64 ? Keypair.fromSecretKey(b) : Keypair.fromSeed(b); };
const master = keyFrom(process.env.MASTER_SECRET_KEY); if (!master) die('MASTER_SECRET_KEY not set');
const extra = [keyFrom(process.env.ADMIN_SECRET_KEY), CREATOR(), CREATOR2()].filter(Boolean);
const signers = Object.fromEntries([master, ...extra].map((k) => [k.publicKey.toBase58(), k]));

const D = { resolve: [246, 150, 236, 206, 108, 63, 58, 10], closePosition: [123, 134, 81, 0, 49, 68, 98, 98], claimFee: [169, 32, 79, 137, 136, 232, 70, 137], sweepResidual: [230, 118, 35, 155, 165, 110, 141, 19], closeMarket: [88, 154, 248, 186, 48, 14, 123, 244] };
const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
const MARKET_DISC = Buffer.from('dbbed53700e3c69a', 'hex');
const REGISTRY = PublicKey.findProgramAddressSync([Buffer.from('registry')], PROGRAM_ID)[0];
const ix = (disc, data, keys) => new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([Buffer.from(disc), data]), keys: keys.map(([pubkey, isWritable, isSigner]) => ({ pubkey, isWritable, isSigner })) });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const positionPda = (market, owner) => PublicKey.findProgramAddressSync([Buffer.from('position'), market.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];

async function send(ixs, payer, extraSigners = []) {
  if (DRY) return 'dry';
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }), ...ixs);
  for (let t = 0; ; t++) {
    try { return await sendAndConfirmTransaction(conn, tx, [payer, ...extraSigners], { commitment: 'confirmed' }); }
    catch (e) { if (t >= 2) throw e; await sleep(3000); }
  }
}

// every position account → its market + holder (ours by PDA, others from the position's first transaction)
async function positionIndex(markets) {
  const all = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(POSITION_DISC) } }] });
  const byKey = new Map(all.map((x) => [x.pubkey.toBase58(), x.account]));
  const owners = walletIndices().map((i) => wallet(i).publicKey).concat([wallet(40).publicKey]);
  const found = new Map(); // positionKey → { market, holder }
  for (const m of markets) for (const o of owners) { const p = positionPda(m.pubkey, o).toBase58(); if (byKey.has(p)) found.set(p, { market: m.pubkey.toBase58(), holder: o }); }
  const unknown = [...byKey.keys()].filter((k) => !found.has(k));
  const marketKeys = new Set(markets.map((m) => m.pubkey.toBase58()));
  for (const pk of unknown) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pk), { limit: 20 });
    for (const s of sigs.reverse()) {
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null); await sleep(120);
      const keys = tx ? tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys : [];
      const mk = keys.filter((k) => marketKeys.has(k.toBase58()));
      for (const m of mk) for (const k of keys) if (positionPda(m, k).toBase58() === pk) { found.set(pk, { market: m.toBase58(), holder: k }); break; }
      if (found.has(pk)) break;
    }
  }
  return { byKey, found, unresolved: [...byKey.keys()].filter((k) => !found.has(k)) };
}

async function chooseOutcome(q, m, local) {
  if (a.outcome) { const hit = String(a.outcome).split(',').map((x) => x.split('=')).find(([k]) => Number(k) === q); if (hit) return { i: Number(hit[1]), source: 'manual' }; }
  if (local?.polymarket?.id) {
    try { const r = await yesProbability(local.polymarket); if (r.p != null) return { i: r.p >= 0.5 ? 0 : 1, source: `${r.market?.closed ? 'polymarket-final' : 'polymarket-now'} p=${r.p}` }; } catch { /* fall through */ }
  }
  const model = new LsLmsr({ alpha: Number(m.alpha_wad.toString()) / 1e18, q: m.outcome_shares_wad.map((w) => Number(w.toString()) / 1e18) });
  const p = model.normPrices(); const i = p.indexOf(Math.max(...p)); return { i, source: `onchain p=${p.map((x) => x.toFixed(3)).join('/')}` };
}

const only = a.quest ? new Set(String(a.quest).split(',').map(Number)) : null;
const raw = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(MARKET_DISC) } }] });
const markets = raw.map((x) => ({ pubkey: x.pubkey, lamports: x.account.lamports, m: decodeAccount(x.account.data) })).map((x) => ({ ...x, q: Number(x.m.question_id.readBigUInt64LE(0)) }));
const targets = markets.filter((x) => !only || only.has(x.q));
const local = Object.fromEntries(allMarkets().map((m) => [m.questId, m]));
const idx = await positionIndex(markets);
console.error(`markets ${markets.length} (targets ${targets.length}), positions ${idx.byKey.size}, holders unknown ${idx.unresolved.length}`);

const out = [];
for (const { pubkey: market, m, q } of targets) {
  const rec = { q, title: local[q]?.title?.slice(0, 60) ?? null, seeder: m.seeder.toBase58(), steps: [] }; out.push(rec);
  try {
    const admin = signers[m.admin.toBase58()]; const resolver = m.resolver ? signers[m.resolver.toBase58()] : null;
    if (!admin) { rec.result = `skip: admin ${m.admin.toBase58()} not ours`; continue; }
    const mint = m.collateral_mint; const vault = m.vault; const pay = master;
    // 1. resolve
    let winner = m.winning_outcome;
    if (!m.is_resolved) { const o = await chooseOutcome(q, m, local[q]); winner = o.i; rec.outcome = o; await send([ix(D.resolve, Buffer.from([o.i]), [[(resolver || admin).publicKey, true, true], [market, true, false]])], pay, (resolver || admin) === pay ? [] : [resolver || admin]); rec.steps.push(`resolve ${o.i}`); }
    else rec.outcome = { i: winner, source: 'already resolved' };
    // 2. close every position
    const mine = [...idx.found.entries()].filter(([, v]) => v.market === market.toBase58());
    rec.positions = mine.length; rec.openPositions = m.open_positions;
    let closed = 0;
    for (let i = 0; i < mine.length; i += 4) {
      const batch = mine.slice(i, i + 4); const ixs = [];
      for (const [pk, { holder }] of batch) {
        const ata = getAssociatedTokenAddressSync(mint, holder, true);
        const bal = idx.byKey.get(pk).data; const units = bal.readBigUInt64LE(8 + 8 * winner);
        if (units > 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(pay.publicKey, ata, holder, mint));
        const keys = [[pay.publicKey, false, true], [holder, true, false], [market, true, false], [vault, true, false], [mint, false, false], [new PublicKey(pk), true, false], [TOKEN_PROGRAM_ID, false, false]];
        if (units > 0n) keys.push([ata, true, false]);
        ixs.push(ix(D.closePosition, Buffer.alloc(0), keys));
      }
      await send(ixs, pay); closed += batch.length;
    }
    rec.steps.push(`closed ${closed} positions`);
    // 3. fees
    const fresh = DRY ? m : decodeAccount((await conn.getAccountInfo(market)).data);
    for (const [label, claimer, amt] of [['platform', master, fresh.accrued_platform_fee_units], ['creator', signers[m.seeder.toBase58()], fresh.accrued_creator_fee_units]]) {
      if (!amt || amt.isZero()) continue;
      if (!claimer) { rec.steps.push(`${label} fee ${amt.toString()} unclaimable (no key)`); continue; }
      const cAta = getAssociatedTokenAddressSync(mint, claimer.publicKey, true);
      try { await send([createAssociatedTokenAccountIdempotentInstruction(pay.publicKey, cAta, claimer.publicKey, mint), ix(D.claimFee, Buffer.alloc(0), [[claimer.publicKey, false, true], [REGISTRY, false, false], [market, true, false], [vault, true, false], [mint, false, false], [cAta, true, false], [TOKEN_PROGRAM_ID, false, false]])], pay, claimer === pay ? [] : [claimer]); rec.steps.push(`${label} fee claimed`); }
      catch (e) { rec.steps.push(`${label} fee claim failed: ${e.message.slice(0, 80)}`); }
    }
    // 4. sweep the vault, 5. close the market
    if (!DRY) {
      // the program only accepts the seeder's token account as the sweep destination
      const dest = getAssociatedTokenAddressSync(mint, m.seeder, true);
      // a balance read right after the fee claims can still be stale (sweeping more than the vault holds fails
      // with MathUnderflow), so wait, re-read and retry
      for (let t = 0; ; t++) {
        await sleep(6000);
        const vbal = (await getAccount(conn, vault, 'confirmed')).amount;
        const ixs = [createAssociatedTokenAccountIdempotentInstruction(pay.publicKey, dest, m.seeder, mint)];
        if (vbal > 0n) ixs.push(ix(D.sweepResidual, u64(vbal), [[admin.publicKey, true, true], [market, true, false], [vault, true, false], [mint, false, false], [dest, true, false], [TOKEN_PROGRAM_ID, false, false]]));
        ixs.push(ix(D.closeMarket, Buffer.alloc(0), [[admin.publicKey, false, true], [market, true, false], [vault, true, false], [m.seeder, true, false], [TOKEN_PROGRAM_ID, false, false]]));
        try { rec.sig = await send(ixs, pay, admin === pay ? [] : [admin]); rec.swept = vbal.toString(); break; }
        catch (e) { if (t >= 2) throw e; }
      }
      await sleep(4000); rec.result = (await conn.getAccountInfo(market)) ? 'market still open' : 'closed';
    } else rec.result = 'dry';
  } catch (e) { rec.result = `error: ${e.message.slice(0, 200)}`; }
  console.error(JSON.stringify(rec));
}
fs.mkdirSync('state/reports', { recursive: true });
fs.appendFileSync('state/reports/onchain-close.jsonl', out.map((r) => JSON.stringify({ t: new Date().toISOString(), dry: DRY, ...r })).join('\n') + '\n');
pj({ dry: DRY, markets: out.length, closed: out.filter((r) => r.result === 'closed').length, unknownHolders: idx.unresolved.length, results: out.map((r) => ({ q: r.q, outcome: r.outcome, positions: r.positions, openPositions: r.openPositions, result: r.result, steps: r.steps })) });
process.exit(0);
