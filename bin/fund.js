// Funding CLI.
//   --balances                                   SOL/USDP of all 32 wallets
//   --plan [--mode initial|topup] [overrides]    show transfers without sending
//   --initial [--traders N] [overrides]          FUNDER → CREATOR + TRADER-01..N (default: all 30)
//       overrides: --creator-sol X --trader-sol X --creator-usdp X --trader-usdp X (this run only; defaults from settings)
//   --topup | --sweep [--include-creator]
//   --from-master --sol X --usdp Y               MASTER_SECRET_KEY → FUNDER (plain transfer)
//   --from-admin  --sol X --usdp Y               ADMIN_SECRET_KEY  → FUNDER (plain transfer)
import { parseArgs, pj } from './_cli.js';
import * as f from '../src/funding.js';
const a = parseArgs();
const n = (k) => (a[k] === undefined || a[k] === true ? undefined : Number(a[k]));
const overrides = { traders: n('traders'), creatorSolInit: n('creator-sol'), traderSolInit: n('trader-sol'), creatorUsdpInit: n('creator-usdp'), traderUsdpInit: n('trader-usdp') };
const amounts = { sol: Number(a.sol || 0), usdp: Number(a.usdp || 0) };
if (a['from-master']) pj(await f.fundFromMaster(amounts));
else if (a['from-admin']) pj(await f.fundFromAdmin(amounts));
else if (a.initial) pj(await f.distributeInitial(overrides));
else if (a.topup) pj(await f.topUp());
else if (a.sweep) pj(await f.sweep({ includeCreator: !!a['include-creator'] }));
else if (a.balances) { const rows = await f.refreshBalances(); for (const r of rows) console.log(`[${String(r.index).padStart(2)}] ${r.label.padEnd(10)} ${r.address} ${String(r.sol).padStart(10)} SOL ${String(r.usdp).padStart(14)} USDP`); }
else { const rows = await f.refreshBalances(); pj(f.plan(rows, a.mode || 'initial', overrides)); }
