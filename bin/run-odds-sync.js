import { pj } from './_cli.js';
import { syncAll } from '../src/oddsSync.js';
const r = await syncAll(); pj({ ...r, results: r.results.map((x) => ({ questId: x.questId, pBefore: x.pBefore, pTarget: x.pTarget, pAfter: x.pAfter, spend: x.spend, skipped: x.skipped, error: x.error })) }); process.exit(0);
