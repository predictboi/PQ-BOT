// Claim winnings on resolved quests for every trader + creator wallet (user flow: createClaim → sign → confirmClaim).
//   node bin/claim.js                 all claimable quests
//   node bin/claim.js --quest 900045  only this quest
import { claimAll } from '../src/claims.js';
import { parseArgs, pj } from './_cli.js';
const a = parseArgs();
pj(await claimAll({ questIds: a.quest ? String(a.quest).split(',').map(Number) : null })); process.exit(0);
