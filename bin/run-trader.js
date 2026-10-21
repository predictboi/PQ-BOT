import { parseArgs } from './_cli.js';
import { VolumeTrader } from '../src/trader.js';
const a = parseArgs(); const minutes = Number(a.minutes || 0); const deadline = minutes ? Date.now() + minutes * 60000 : Infinity;
const t = new VolumeTrader(); await t.run({ shouldStop: () => Date.now() > deadline });
console.log(JSON.stringify(t.stats)); process.exit(0);
