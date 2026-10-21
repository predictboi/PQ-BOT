// Log every wallet in once (creates its user row on the platform) and print roles. Safe, no on-chain tx.
//   --only CREATOR,TRADER-01,TRADER-02     limit to these labels
//   --email-domain tmp-abc123.xyz          also register an email per wallet: creator1@<domain>, trade1@<domain>, trade2@<domain> …
import { allWallets } from '../src/wallets.js';
import { login, sessionInfo, setEmail } from '../src/client/polyquest.js';
import { sleep } from '../src/util.js';
import { parseArgs } from './_cli.js';
const a = parseArgs();
const only = a.only ? new Set(String(a.only).split(',').map((x) => x.trim().toUpperCase())) : null;
const emailFor = (w) => (a['email-domain'] ? `${w.role === 'CREATOR' ? 'creator1' : w.role === 'FUNDER' ? 'funder1' : `trade${w.index - 1}`}@${a['email-domain']}` : null);
let ok = 0, fail = 0;
for (const w of allWallets()) {
  if (only && !only.has(w.label.toUpperCase())) continue;
  try {
    const s = await login(w.kp); let i = await sessionInfo(s); let note = '';
    const email = emailFor(w);
    if (email && i?.user?.email !== email) { const set = await setEmail(s, email); i = await sessionInfo(s); note = set ? ` email=${i?.user?.email}` : ` email-set FAILED (now ${i?.user?.email || 'null'})`; }
    else if (email) note = ` email=${i?.user?.email} (already)`;
    console.log(`${w.label.padEnd(10)} ${w.address} role=${i?.user?.role || '?'}${note}`); ok++;
  } catch (e) { console.log(`${w.label.padEnd(10)} ${w.address} FAIL ${e.message.slice(0, 80)}`); fail++; }
  await sleep(1500);
}
console.log(`\nlogged in ${ok}, failed ${fail}`);
