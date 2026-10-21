// Funding CLI.  --plan | --initial | --topup | --sweep [--include-creator] | --from-master --sol X --usdp Y | --balances
import { parseArgs, pj } from './_cli.js';
import * as f from '../src/funding.js';
const a = parseArgs();
if (a['from-master']) pj(await f.fundFromMaster({ sol: Number(a.sol || 0), usdp: Number(a.usdp || 0) }));
else if (a.initial) pj(await f.distributeInitial());
else if (a.topup) pj(await f.topUp());
else if (a.sweep) pj(await f.sweep({ includeCreator: !!a['include-creator'] }));
else if (a.balances) { const rows = await f.refreshBalances(); for (const r of rows) console.log(`[${String(r.index).padStart(2)}] ${r.label.padEnd(10)} ${r.address} ${String(r.sol).padStart(10)} SOL ${String(r.usdp).padStart(14)} USDP`); }
else { const rows = await f.refreshBalances(); pj(f.plan(rows, a.mode || 'initial')); }
