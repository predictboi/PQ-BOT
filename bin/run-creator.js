import { parseArgs, pj } from './_cli.js';
import { replenish, syncFromPlatform, shortfall, creatorStatus } from '../src/creator.js';
const a = parseArgs();
if (a.sync) pj({ sync: await syncFromPlatform(), shortfall: shortfall() });
else if (a.status) pj(await creatorStatus());
else pj(await replenish({ maxCreate: a.max ? Number(a.max) : undefined }));
process.exit(0);
