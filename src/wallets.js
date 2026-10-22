// All wallets derive deterministically from ONE mnemonic (Phantom/Solflare-compatible BIP44 m/44'/501'/{i}'/0').
//   index 0       FUNDER  (treasury: user deposits SOL/USDP here; hub for distribution/sweep)
//   index 1       CREATOR (creates/resolves markets; needs Creator role on the platform)
//   index 2..31   TRADER 01..30 (volume + odds sync)
//   index 32      CREATOR-02 (second creator, promoted on the platform; appended after the traders)
// The mnemonic is read from MNEMONIC (env) or MNEMONIC_FILE (path). It is never written anywhere by this module.
import fs from 'node:fs';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';
import { CONFIG } from './config.js';

export const FUNDER_INDEX = 0;
export const CREATOR_INDEX = 1;
export const FIRST_TRADER_INDEX = 2;
export const CREATOR2_INDEX = 32;

export function roleOf(i) {
  if (i === FUNDER_INDEX) return { role: 'FUNDER', label: 'FUNDER' };
  if (i === CREATOR_INDEX) return { role: 'CREATOR', label: 'CREATOR' };
  if (i === CREATOR2_INDEX) return { role: 'CREATOR', label: 'CREATOR-02' };
  return { role: 'TRADER', label: `TRADER-${String(i - FIRST_TRADER_INDEX + 1).padStart(2, '0')}` };
}
/** Managed derivation indices: FUNDER, CREATOR, TRADER-01..N, CREATOR-02. */
export const walletIndices = () => [...Array.from({ length: FIRST_TRADER_INDEX + CONFIG.traderCount }, (_, i) => i), CREATOR2_INDEX];
export const walletCount = () => walletIndices().length;

let _seedHex = null;
function loadMnemonic() {
  let m = process.env.MNEMONIC;
  if (!m && process.env.MNEMONIC_FILE) { try { m = fs.readFileSync(process.env.MNEMONIC_FILE, 'utf8'); } catch { m = ''; } }
  m = (m || '').trim().replace(/\s+/g, ' ');
  return m;
}
export function hasMnemonic() { return !!loadMnemonic(); }
export function assertMnemonic() {
  const m = loadMnemonic();
  if (!m) throw new Error('MNEMONIC is not set (Environment Secrets / Railway Variables / .env). Run `npm run gen-mnemonic` once to create one.');
  if (!bip39.validateMnemonic(m)) throw new Error('MNEMONIC is not a valid BIP39 phrase (check word count / spelling).');
  return m;
}
function seedHex() {
  if (!_seedHex) _seedHex = bip39.mnemonicToSeedSync(assertMnemonic()).toString('hex');
  return _seedHex;
}

/** Derive keypair i from a given mnemonic (pure; used by init/verification). */
export function keypairFromMnemonic(mnemonic, i) {
  const seed = bip39.mnemonicToSeedSync(mnemonic.trim().replace(/\s+/g, ' ')).toString('hex');
  return Keypair.fromSeed(derivePath(`m/44'/501'/${i}'/0'`, seed).key);
}
export function wallet(i) { return Keypair.fromSeed(derivePath(`m/44'/501'/${i}'/0'`, seedHex()).key); }
export const FUNDER = () => wallet(FUNDER_INDEX);
export const CREATOR = () => wallet(CREATOR_INDEX);
export const CREATOR2 = () => wallet(CREATOR2_INDEX);
export const TRADER = (n) => { if (!(n >= 1 && n <= CONFIG.traderCount)) throw new Error(`trader n out of range: ${n}`); return wallet(FIRST_TRADER_INDEX + n - 1); };

/** All wallets with keypairs (requires MNEMONIC). */
export function allWallets() {
  return walletIndices().map((i) => { const kp = wallet(i); return { index: i, ...roleOf(i), kp, address: kp.publicKey.toBase58() }; });
}
export const traderWallets = () => allWallets().filter((w) => w.role === 'TRADER');
/** CREATOR-role keypair by label ('CREATOR' | 'CREATOR-02'); unknown labels fall back to CREATOR. */
export const creatorByLabel = (label) => (label === roleOf(CREATOR2_INDEX).label ? CREATOR2() : CREATOR());
export const creatorLabels = () => [roleOf(CREATOR_INDEX).label, roleOf(CREATOR2_INDEX).label];

/** Address table only (no secrets) — what state/addresses.json contains. */
export function deriveAddresses(mnemonic = assertMnemonic(), indices = walletIndices()) {
  return indices.map((i) => ({ index: i, ...roleOf(i), address: keypairFromMnemonic(mnemonic, i).publicKey.toBase58() }));
}
export function generateMnemonic() { return bip39.generateMnemonic(256); } // 24 words
