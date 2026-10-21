// Main entry (Railway `npm start`): supervisor (all agents on their schedules) + dashboard HTTP server.
//   --dashboard-only   serve the dashboard without starting agents
//   --only a,b         start only these agents
import { parseArgs } from './_cli.js';
import { CONFIG } from '../src/config.js';
import { Supervisor } from '../src/agents/supervisor.js';
import { startDashboard } from '../src/dashboard/server.js';
import { createLogger } from '../src/util.js';
const log = createLogger('main'); const a = parseArgs();
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
const S = new Supervisor();
const server = startDashboard(S, { port: Number(a.port || CONFIG.dashboard.port) });
if (!a['dashboard-only']) await S.start({ only: a.only ? String(a.only).split(',') : undefined });
else await S.refreshSetup().catch(() => {});
const shutdown = () => { log.info('shutting down'); S.stop(); server.close(); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
