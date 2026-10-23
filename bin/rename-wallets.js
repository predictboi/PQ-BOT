// Give the bot wallets natural display names via the user flow (My Page pencil edit → user.updateName).
//   node bin/rename-wallets.js --dry               print the planned names only
//   node bin/rename-wallets.js                     traders + creators
//   node bin/rename-wallets.js --only TRADER-01    one wallet
//   node bin/rename-wallets.js --salt v2           a different name set
import path from 'node:path';
import { allWallets } from '../src/wallets.js';
import { generateNames, NAME_RE } from '../src/usernames.js';
import { PATHS } from '../src/config.js';
import * as pq from '../src/client/polyquest.js';
import { appendJsonl, sleep } from '../src/util.js';
import { parseArgs, pj } from './_cli.js';

const a = parseArgs();
const wallets = allWallets().filter((w) => w.role !== 'FUNDER' && (!a.only || String(a.only).split(',').includes(w.label)));
const names = generateNames(allWallets().filter((w) => w.role !== 'FUNDER').map((w) => w.label), { salt: a.salt || 'v1' });
if (a.dry) { pj(Object.fromEntries(wallets.map((w) => [w.label, names[w.label]]))); process.exit(0); }

const REPORT = path.join(PATHS.reports, 'usernames.jsonl'); const out = [];
for (const w of wallets) {
  const name = names[w.label]; const rec = { t: new Date().toISOString(), wallet: w.label, name };
  try {
    if (!NAME_RE.test(name)) throw new Error('invalid name');
    const sess = await pq.login(w.kp);
    const before = (await pq.sessionInfo(sess))?.user?.name ?? null;
    await pq.trpc(sess, 'user.updateName', name);
    const after = (await pq.sessionInfo(await pq.login(w.kp)))?.user?.name ?? null;
    Object.assign(rec, { before, after, ok: after === name });
  } catch (e) { Object.assign(rec, { ok: false, error: e.message.slice(0, 200) }); }
  out.push(rec); appendJsonl(REPORT, rec); console.log(`${rec.ok ? 'ok ' : 'ERR'} ${w.label} → ${name}${rec.error ? ` (${rec.error})` : ''}`);
  await sleep(1500);
}
pj({ ok: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok) }); process.exit(0);
