// Day-0: generate the ROOT mnemonic (24 words) into a file (mode 0600). The phrase is never printed to stdout.
//   node bin/gen-mnemonic.js --out /path/to/MNEMONIC.txt
import fs from 'node:fs';
import { parseArgs, die } from './_cli.js';
import { generateMnemonic, deriveAddresses } from '../src/wallets.js';
const a = parseArgs(); const out = a.out || process.env.MNEMONIC_OUT; if (!out) die('usage: gen-mnemonic --out <file>');
if (fs.existsSync(out) && !a.force) die(`${out} exists — refusing to overwrite (use --force)`);
const m = generateMnemonic();
fs.writeFileSync(out, m + '\n', { mode: 0o600 });
const rows = deriveAddresses(m, 32);
console.log(`mnemonic written to ${out} (24 words, NOT printed). First addresses:`);
for (const r of rows.slice(0, 3)) console.log(`  [${r.index}] ${r.label.padEnd(10)} ${r.address}`);
console.log('Next: register it as MNEMONIC in Environment Secrets / Railway, then `npm run init-wallets`.');
