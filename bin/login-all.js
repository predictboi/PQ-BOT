// Log every wallet in once (creates its user row on the platform) and print roles. Safe, no on-chain tx.
import { allWallets } from '../src/wallets.js';
import { login, sessionInfo } from '../src/client/polyquest.js';
import { sleep } from '../src/util.js';
let ok = 0, fail = 0;
for (const w of allWallets()) {
  try { const s = await login(w.kp); const i = await sessionInfo(s); console.log(`${w.label.padEnd(10)} ${w.address} role=${i?.user?.role || '?'}`); ok++; }
  catch (e) { console.log(`${w.label.padEnd(10)} ${w.address} FAIL ${e.message.slice(0, 80)}`); fail++; }
  await sleep(1500);
}
console.log(`\nlogged in ${ok}, failed ${fail}`);
