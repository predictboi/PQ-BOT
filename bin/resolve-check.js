// node bin/resolve-check.js            → check all (Polymarket resolved → updateStatus)
// node bin/resolve-check.js --resolve <questId> <YES|NO|REVOKE>   → manual resolution via the creator flow
import { parseArgs, pj, die } from './_cli.js';
import { checkAll, resolveMarket } from '../src/resolver.js';
const a = parseArgs();
if (a.resolve) { const [w] = a._; if (!/^(YES|NO|REVOKE)$/.test(w || '')) die('usage: --resolve <questId> <YES|NO|REVOKE>'); pj(await resolveMarket(Number(a.resolve), w, { reason: 'cli' })); }
else pj(await checkAll());
process.exit(0);
