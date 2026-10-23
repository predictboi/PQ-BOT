// Headless Polyquest client — the SAME calls the web frontend makes (user flow only).
// Auth: NextAuth v4 Credentials + Solana wallet signature (custom message, not SIWS). Transport: superjson tRPC + cookie jar.
// Ported from tools/solana-lslmsr-test/polyquest.mjs (verified against solana-stg.polyquest.xyz).
import crypto from 'node:crypto';
import bs58 from 'bs58';
import { VersionedTransaction, Transaction } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { withTimeout, sleep, createLogger } from '../util.js';

const BASE = CONFIG.apiBase;
const log = createLogger('client');

// ---- Ed25519 signing via Node crypto (secretKey = 32B seed || 32B pubkey) ----
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export function signMessage(kp, message) {
  const seed = Buffer.from(kp.secretKey.slice(0, 32));
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message, 'utf8'), key);
}

// ---- cookie jar ----
function addCookies(jar, res) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of set) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
}
const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

// ---- auth handshake (4 steps) → session { jar, address, kp } ----
export async function login(kp) {
  const jar = new Map();
  let r = await fetch(`${BASE}/api/auth/csrf`, { headers: { accept: 'application/json' } });
  addCookies(jar, r);
  const { csrfToken } = await r.json();
  let nonce, message;
  for (let attempt = 0; attempt < 4; attempt++) { // the nonce endpoint rate-limits bursts (empty body / 429) → back off and retry
    r = await fetch(`${BASE}/api/auth/nonce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletAddress: kp.publicKey.toBase58(), chainType: 'SOLANA' }) });
    addCookies(jar, r);
    const j = await r.json().catch(() => ({})); nonce = j.nonce; message = j.message;
    if (message) break;
    if (attempt === 3) throw new Error(`nonce step failed (HTTP ${r.status}): ${JSON.stringify(j).slice(0, 120)}`);
    await sleep(2500 * 2 ** attempt);
  }
  const signature = bs58.encode(signMessage(kp, message));
  r = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(jar) },
    body: JSON.stringify({ chainType: 'SOLANA', walletName: 'automation', walletAddress: kp.publicKey.toBase58(), nonce, signature, csrfToken, json: 'true' }),
    redirect: 'manual',
  });
  addCookies(jar, r);
  if (![...jar.keys()].some((k) => k.includes('next-auth.session-token'))) throw new Error(`login failed (status ${r.status}) — no session cookie. ${(await r.text()).slice(0, 160)}`);
  return { jar, address: kp.publicKey.toBase58(), kp, loggedInAt: Date.now() };
}

/** NextAuth session (user row incl. role: USER | CREATOR | ADMIN). */
export async function sessionInfo(sess) {
  const r = await fetch(`${BASE}/api/auth/session`, { headers: { cookie: cookieHeader(sess.jar) } });
  return r.json().catch(() => ({}));
}

export async function setEmail(sess, email) {
  const cookie = () => cookieHeader(sess.jar);
  const m = await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie: cookie() } })).json();
  const { csrfToken } = await (await fetch(`${BASE}/api/auth/csrf`, { headers: { cookie: cookie() } })).json();
  const r = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie() }, body: JSON.stringify({ csrfToken, data: { ...m, user: { ...m.user, email }, updateType: 'WEB3_ADD_EMAIL' } }) });
  addCookies(sess.jar, r);
  const j = await r.json().catch(() => ({}));
  return j?.user?.email === email;
}

// ---- tRPC (superjson) ----
export class TrpcError extends Error { constructor(proc, j, status) { super(`tRPC ${proc}: ${JSON.stringify(j?.error?.json?.message || j?.error || j).slice(0, 300)}`); this.proc = proc; this.code = j?.error?.json?.data?.code; this.status = status; } }

export async function trpc(sess, procedure, input, meta) {
  const body = meta ? { json: input, meta } : { json: input };
  const r = await fetch(`${BASE}/api/trpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sess ? cookieHeader(sess.jar) : '' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j?.error) throw new TrpcError(procedure, j, r.status);
  if (!r.ok) throw new Error(`tRPC ${procedure} HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j?.result?.data?.json ?? j?.result?.data ?? j;
}
export async function trpcQuery(sess, procedure, input) {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const r = await fetch(`${BASE}/api/trpc/${procedure}${qs}`, { headers: { cookie: sess ? cookieHeader(sess.jar) : '' } });
  const j = await r.json().catch(() => ({}));
  if (j?.error) throw new TrpcError(procedure, j, r.status);
  return j?.result?.data?.json ?? j?.result?.data ?? j;
}
const peel = (r) => r?.data ?? r; // mutation payloads are wrapped in { data }
const T = CONFIG.timeouts;

// ---- public reads (no session needed) ----
export const categories = async () => peel(await withTimeout(trpcQuery(null, 'category.listAll'), T.read, 'categories'));
export const tokens = async () => peel(await withTimeout(trpcQuery(null, 'token.listAll'), T.read, 'tokens'));
export const questDetail = async (questId) => peel(await withTimeout(trpcQuery(null, 'quest.detail', Number(questId)), T.read, 'detail'));
/** { prices:[yes,no] (normalized), marketState:{ outcomeSharesWad[], alphaWad, wadPerUnit, platformFeeBps, creatorFeeBps } } */
export const lslmsrState = async (questId) => withTimeout(trpcQuery(null, 'quest.lslmsrState', Number(questId)), T.read, 'lslmsrState');
export const lslmsrStates = async (questIds) => withTimeout(trpcQuery(null, 'quest.lslmsrStates', { questIds: questIds.map(Number) }), T.read, 'lslmsrStates');
export const listAll = async ({ page = 1, pageSize = 100, order = 'most_recent', categoryId } = {}) => withTimeout(trpcQuery(null, 'quest.listAll', { page, pageSize, order, ...(categoryId ? { categoryId } : {}) }), T.read, 'listAll');
export const listByWallet = async (sess, walletAddress, { page = 1, pageSize = 100, status } = {}) => withTimeout(trpcQuery(sess, 'quest.listByWallet', { walletAddress: walletAddress ?? sess?.address, page, pageSize, ...(status ? { status } : {}) }), T.read, 'listByWallet'); // requires the wallet's session
export const priceHistory = async (questId, interval = '1h') => peel(await withTimeout(trpcQuery(null, 'quest.lslmsrPriceHistory', { questId: Number(questId), interval }), T.read, 'priceHistory'));
export const betsByWallet = async (sess, walletAddress, { page = 1, pageSize = 50 } = {}) => withTimeout(trpcQuery(sess, 'betting.listByWallet', { walletAddress: walletAddress ?? sess?.address, page, pageSize }), T.read, 'betsByWallet');
export const positionsByWallet = async (sess, walletAddress) => peel(await withTimeout(trpcQuery(sess, 'betting.listLslmsrPositionsByWallet', { walletAddress: walletAddress ?? sess?.address }), T.read, 'positions'));
export const betsByQuest = async (questId, { page = 1, pageSize = 50 } = {}) => withTimeout(trpcQuery(null, 'betting.listByQuest', { questId: Number(questId), page, pageSize }), T.read, 'betsByQuest');

/** All quests created by `walletAddress` (paginates). */
export async function allQuestsByWallet(sess, walletAddress) {
  const out = []; let page = 1;
  for (;;) { const r = await listByWallet(sess, walletAddress, { page, pageSize: 100 }); const arr = r?.data ?? []; out.push(...arr); if (!r?.hasMore || arr.length === 0 || page > 20) break; page++; }
  return out;
}

// ---- signing ----
export function signEncodedTx(kp, encodedTx) {
  const raw = Buffer.from(encodedTx, 'base64');
  try { const tx = VersionedTransaction.deserialize(raw); tx.sign([kp]); return Buffer.from(tx.serialize()).toString('base64'); }
  catch { const tx = Transaction.from(raw); tx.partialSign(kp); return tx.serialize().toString('base64'); }
}

// ---- market creation = quest.draft → sign → quest.confirmDraftLslmsr ----
export async function createMarket(sess, kp, q) {
  const input = {
    type: 'LSLMSR', title: q.title, description: q.description ?? null, relevantLink: q.relevantLink ?? null,
    creatorAddress: kp.publicKey.toBase58(), creatorFeePercent: q.creatorFeePercent ?? CONFIG.market.creatorFeePercent,
    endDate: q.endDateISO, tokenId: q.tokenId ?? CONFIG.usdpTokenId, categoryId: q.categoryId ?? null,
    imageUrl: q.imageUrl, minBetAmount: q.minBetAmount ?? CONFIG.market.minBetAmount, minRaiseAmount: q.minRaiseAmount ?? CONFIG.market.minRaiseAmount,
    programVersion: CONFIG.market.programVersion, collateralKind: q.collateralKind ?? CONFIG.market.collateralKind,
    answers: q.answers, seed: String(q.seed ?? CONFIG.market.seed), alpha: String(q.alpha ?? CONFIG.market.alpha), openingRatios: q.openingRatios.map(String),
  };
  if (CONFIG.dryRun) { log.info('DRY_RUN createMarket', input.title); return { questId: null, dryRun: true, input }; }
  const draft = peel(await withTimeout(trpc(sess, 'quest.draft', input, { values: { endDate: ['Date'] } }), T.trade, 'quest.draft'));
  const questId = draft.quest?.id;
  if (!draft.encodedTx) throw new Error(`quest.draft returned no encodedTx (questId ${questId})`);
  const signedTx = signEncodedTx(kp, draft.encodedTx);
  await withTimeout(trpc(sess, 'quest.confirmDraftLslmsr', { questId, signedTx }), T.trade, 'quest.confirmDraftLslmsr');
  return { questId, quest: draft.quest, answers: draft.quest?.answers };
}

// ---- bets: betting.draftLslmsr → sign → betting.confirm / betting.confirmSell (+ read-back verification) ----
export async function verifyBetLanded(sess, addr, bettingId, { tries = 4, delayMs = 2500, expect = null } = {}) {
  if (bettingId === undefined || bettingId === null) return { landed: false, reason: 'no-id' };
  for (let a = 0; a < tries; a++) {
    try {
      const r = await betsByWallet(sess, addr, { pageSize: 30 });
      const list = r?.data ?? r; const arr = Array.isArray(list) ? list : (list?.items ?? list?.bettings ?? []);
      const rec = arr.find((b) => b.id === bettingId);
      if (rec?.bettingTxn && rec.isValid !== false) return { landed: true, txn: rec.bettingTxn, rec };
      // backend race: the on-chain indexer records the trade as its own row (source ACTIONS) and voids our draft row
      // (listByWallet then hides it) while betting.confirm answers 500 — the twin row right after the draft is the fill
      const want = expect || rec;
      if (want && (!rec || rec.isValid === false)) {
        const twin = arr.find((b) => b.id > bettingId && b.id <= bettingId + 5 && b.isValid !== false && b.bettingTxn && Number(b.questId) === Number(want.questId) && Number(b.answerId) === Number(want.answerId) && b.kind === want.kind && Math.abs(Number(b.spent) - Number(want.spent)) < 0.01);
        if (twin) return { landed: true, txn: twin.bettingTxn, rec: twin, viaTwin: true };
      }
    } catch { /* transient */ }
    if (a < tries - 1) await sleep(delayMs);
  }
  return { landed: false, reason: 'no-txn' };
}

export async function trade(sess, kp, { questId, answerId, spent, kind = 'BUY', inputTokenAddr = CONFIG.usdpMint }) {
  const input = { questId: Number(questId), answerId: Number(answerId), solAmount: null, spent: Number(spent), source: 'APP', kind };
  if (inputTokenAddr) input.inputTokenAddr = inputTokenAddr;
  if (CONFIG.dryRun) { log.info('DRY_RUN trade', JSON.stringify(input)); return { dryRun: true, betting: null, verified: false }; }
  const d = peel(await withTimeout(trpc(sess, 'betting.draftLslmsr', input), T.trade, 'betting.draftLslmsr'));
  if (!d?.encodedTx) throw new Error(`draftLslmsr returned no encodedTx: ${JSON.stringify(d).slice(0, 160)}`);
  const signedTx = signEncodedTx(kp, d.encodedTx);
  const proc = kind === 'SELL' ? 'betting.confirmSell' : 'betting.confirm';
  const bettingId = d.betting?.id;
  try {
    const c = peel(await withTimeout(trpc(sess, proc, { bettingId, signedTx }), T.trade, proc));
    return { betting: d.betting, confirm: c, verified: false };
  } catch (e) {
    const v = await verifyBetLanded(sess, kp.publicKey.toBase58(), bettingId, { expect: input }); // confirm false-negatives are common
    if (v.landed) return { betting: d.betting, confirm: null, verified: true, bettingTxn: v.txn };
    const err = new Error(`${proc}: ${(e.message || '').slice(0, 100)} | verify:${v.reason}`); err.confirmError = e; throw err;
  }
}

// ---- resolution = quest.updateStatus (backend performs the on-chain resolve with the platform key) ----
export async function updateStatus(sess, questId, status, finalAnswerId) {
  const data = { status }; if (finalAnswerId !== undefined && finalAnswerId !== null) data.finalAnswerId = Number(finalAnswerId);
  if (CONFIG.dryRun) { log.info('DRY_RUN updateStatus', questId, JSON.stringify(data)); return { dryRun: true }; }
  return peel(await withTimeout(trpc(sess, 'quest.updateStatus', { id: Number(questId), data }), T.trade, 'quest.updateStatus'));
}

// ---- session pool: one session per wallet, lazy login, re-login on expiry ----
export class SessionPool {
  constructor({ maxAgeMs = 6 * 3600 * 1000 } = {}) { this.sessions = new Map(); this.maxAgeMs = maxAgeMs; }
  async get(kp, { force = false } = {}) {
    const addr = kp.publicKey.toBase58();
    const cur = this.sessions.get(addr);
    if (!force && cur && Date.now() - cur.loggedInAt < this.maxAgeMs) return cur;
    const sess = await withTimeout(login(kp), T.login, 'login');
    this.sessions.set(addr, sess);
    return sess;
  }
  invalidate(kp) { this.sessions.delete(kp.publicKey.toBase58()); }
  /** Run fn(sess); on auth-ish failure re-login once and retry. */
  async withSession(kp, fn) {
    let sess = await this.get(kp);
    try { return await fn(sess); } catch (e) {
      const m = String(e?.message || ''); const code = e?.code;
      if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || /401|403|unauthor|session/i.test(m)) { sess = await this.get(kp, { force: true }); return fn(sess); }
      throw e;
    }
  }
}
export const sessions = new SessionPool();
export const questUrl = (questId) => `${BASE}/quest/${questId}`;
