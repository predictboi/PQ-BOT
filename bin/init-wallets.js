// Derive all wallet addresses from MNEMONIC and write state/addresses.json (addresses only — safe to commit).
import { deriveAddresses } from '../src/wallets.js';
import { saveAddresses, FILES } from '../src/state.js';
const rows = deriveAddresses();
saveAddresses(rows);
console.log(`wrote ${FILES.addresses} (${rows.length} wallets)`);
for (const r of rows) console.log(`  [${String(r.index).padStart(2)}] ${r.label.padEnd(10)} ${r.address}`);
console.log('\nVerify in Phantom: import the mnemonic → accounts 1..3 must equal index 0..2 above. Do not fund before this matches.');
