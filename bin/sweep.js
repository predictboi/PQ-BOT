import { parseArgs, pj } from './_cli.js';
import { sweep } from '../src/funding.js';
const a = parseArgs(); pj(await sweep({ includeCreator: !!a['include-creator'] })); process.exit(0);
