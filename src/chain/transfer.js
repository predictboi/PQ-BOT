// Plain wallet transfers (SOL / USDP). These are NOT platform actions (allowed by principle 1): funding, top-up, sweep.
import { PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { connection, USDP_MINT } from './read.js';
import { withTimeout, createLogger } from '../util.js';

const log = createLogger('transfer');
const feeIxs = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.priorityFeeMicroLamports })];

async function send(fromKp, ixs, label) {
  if (CONFIG.dryRun) { log.info('DRY_RUN', label); return 'dry-run'; }
  const tx = new Transaction().add(...feeIxs(), ...ixs);
  tx.feePayer = fromKp.publicKey;
  const sig = await withTimeout(sendAndConfirmTransaction(connection(), tx, [fromKp], { commitment: 'confirmed', maxRetries: 3 }), 90000, label);
  log.info(label, sig);
  return sig;
}

/** Transfer `sol` SOL from `fromKp` to `to`. */
export async function transferSol(fromKp, to, sol) {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error('transferSol: amount must be > 0');
  return send(fromKp, [SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey: new PublicKey(to), lamports })], `SOL ${sol} → ${String(to).slice(0, 6)}`);
}

/** Transfer `amount` USDP (ui units) from `fromKp` to `to`, creating the destination ATA if needed (rent paid by sender). */
export async function transferUsdp(fromKp, to, amount) {
  const dec = CONFIG.collateralDecimals;
  const raw = BigInt(Math.round(amount * 10 ** dec));
  if (raw <= 0n) throw new Error('transferUsdp: amount must be > 0');
  const toPk = new PublicKey(to);
  const fromAta = getAssociatedTokenAddressSync(USDP_MINT, fromKp.publicKey);
  const toAta = getAssociatedTokenAddressSync(USDP_MINT, toPk);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(fromKp.publicKey, toAta, toPk, USDP_MINT),
    createTransferCheckedInstruction(fromAta, USDP_MINT, toAta, fromKp.publicKey, raw, dec),
  ];
  return send(fromKp, ixs, `USDP ${amount} → ${String(to).slice(0, 6)}`);
}
