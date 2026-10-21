// Dashboard: plain Node http server. Static UI + JSON API + SSE stream + thumbnail hosting. Token auth (DASHBOARD_TOKEN).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PATHS, CATEGORIES } from '../config.js';
import { getSettings, updateSettings, allMarkets, marketById, loadRuntime } from '../state.js';
import { recentLogs, createLogger, readJsonl } from '../util.js';
import { tradeStats, snapshots, agentRuns, oddsSyncRecent, REPORT_FILES } from '../reporting.js';
import { resolveMarket } from '../resolver.js';
import { tradeOnce } from '../trader.js';
import { walletTable } from '../funding.js';
import { hasMnemonic } from '../wallets.js';

const log = createLogger('dashboard');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } }); });
const cookieOf = (req, k) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([n]) => n === k)?.[1];

function authed(req) {
  const t = CONFIG.dashboard.token; if (!t) return true;
  const h = req.headers.authorization || ''; if (h === `Bearer ${t}`) return true;
  const u = new URL(req.url, 'http://x'); if (u.searchParams.get('token') === t) return true;
  return cookieOf(req, 'pqbot') === t;
}

export function startDashboard(S, { port = CONFIG.dashboard.port } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x'); const p = u.pathname;
      // public: thumbnails (Polyquest backend fetches these), login, static UI shell
      if (p.startsWith('/thumbs/')) { const f = path.join(PATHS.thumbs, path.basename(p)); if (!fs.existsSync(f)) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res); }
      if (p === '/api/login' && req.method === 'POST') { const b = await readBody(req); if (!CONFIG.dashboard.token || b.token === CONFIG.dashboard.token) { res.setHeader('set-cookie', `pqbot=${b.token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`); return json(res, 200, { ok: true }); } return json(res, 401, { ok: false, error: 'invalid token' }); }
      if (p === '/api/auth') return json(res, 200, { required: !!CONFIG.dashboard.token, ok: authed(req) });
      if (p === '/' || p === '/index.html') { res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }); return fs.createReadStream(path.join(PATHS.public, 'index.html')).pipe(res); }
      if (p === '/health') return json(res, 200, { ok: true, uptime: process.uptime(), startedAt: S.startedAt });
      if (!p.startsWith('/api/')) { const f = path.join(PATHS.public, path.normalize(p).replace(/^(\.\.[/\\])+/, '')); if (f.startsWith(PATHS.public) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); } return json(res, 404, { error: 'not found' }); }
      if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

      // ---- read API ----
      if (p === '/api/overview') return json(res, 200, S.snapshot());
      if (p === '/api/setup') return json(res, 200, u.searchParams.get('refresh') ? await S.refreshSetup() : (S.setup || await S.refreshSetup()));
      if (p === '/api/agents') return json(res, 200, Object.values(S.agents).map((a) => a.snapshot()));
      if (p === '/api/markets') { const rt = loadRuntime(); const t = tradeStats(24); return json(res, 200, allMarkets().map((m) => ({ ...m, target: rt.targets?.[m.questId] || null, volume24h: t.byMarket[m.questId] || 0, url: `${CONFIG.apiBase}/quest/${m.questId}` })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))); }
      if (p === '/api/wallets') { const rt = loadRuntime(); const t = tradeStats(24); const rows = (rt.balances?.length ? rt.balances : walletTable()).map((w) => ({ ...w, trades24h: t.byWallet[w.label] || 0, fails24h: t.failByWallet[w.label] || 0 })); return json(res, 200, { rows, at: rt.balancesAt || null, totals: rt.totals || null, hasMnemonic: hasMnemonic() }); }
      if (p === '/api/settings' && req.method === 'GET') return json(res, 200, { settings: getSettings(), categories: CATEGORIES });
      if (p === '/api/logs') return json(res, 200, recentLogs(Number(u.searchParams.get('limit') || 300)));
      if (p === '/api/trades') return json(res, 200, { stats: tradeStats(Number(u.searchParams.get('hours') || 24)), recent: readJsonl(REPORT_FILES.trades, { limit: Number(u.searchParams.get('limit') || 100) }).reverse() });
      if (p === '/api/snapshots') return json(res, 200, snapshots(Number(u.searchParams.get('limit') || 168)));
      if (p === '/api/odds-sync') return json(res, 200, oddsSyncRecent(Number(u.searchParams.get('limit') || 200)).reverse());
      if (p.startsWith('/api/reports/')) { const name = p.split('/')[3]; return json(res, 200, agentRuns(name, Number(u.searchParams.get('limit') || 50)).reverse()); }
      if (p === '/api/daily') { const dir = REPORT_FILES.daily; const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse() : []; const day = u.searchParams.get('day') || files[0]; return json(res, 200, { days: files.map((f) => f.replace('.md', '')), day, markdown: day && fs.existsSync(path.join(dir, `${day}.md`)) ? fs.readFileSync(path.join(dir, `${day}.md`), 'utf8') : '' }); }
      if (p === '/api/events') { // SSE
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': ok\n\n');
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        const onLog = (r) => send('log', r), onAgent = (r) => send('agent', r), onSetup = (r) => send('setup', r);
        S.on('log', onLog); S.on('agent', onAgent); S.on('setup', onSetup);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); S.off('log', onLog); S.off('agent', onAgent); S.off('setup', onSetup); });
        return;
      }

      // ---- control API (POST) ----
      if (req.method !== 'POST') return json(res, 405, { error: 'method' });
      const body = await readBody(req);
      const am = /^\/api\/agents\/([a-zA-Z]+)\/(trigger|pause|resume|start|stop)$/.exec(p);
      if (am) { const a = S.agent(am[1]); const act = am[2]; log.info(`control: ${act} ${am[1]}`, JSON.stringify(body));
        if (act === 'trigger') { const r = await a.trigger('dashboard', body); return json(res, 200, { ok: true, result: body.wait ? a.state.lastResult : r }); }
        if (act === 'pause' || act === 'stop') a.pause(); if (act === 'resume' || act === 'start') a.resume(); return json(res, 200, { ok: true, agent: a.snapshot() }); }
      if (p === '/api/settings') { const s = updateSettings(body); for (const a of Object.values(S.agents)) if (a.cronExpr) { a.stop(); a.stopFlag = false; a.start(); } return json(res, 200, { ok: true, settings: s }); }
      if (p === '/api/funding/refresh') return json(res, 200, { ok: true, result: await S.agent('funding').trigger('dashboard', { mode: 'refresh', wait: true }) });
      if (p === '/api/funding/initial') return json(res, 200, { ok: true, result: await S.agent('funding').trigger('dashboard', { mode: 'initial' }) });
      if (p === '/api/funding/topup') return json(res, 200, { ok: true, result: await S.agent('funding').trigger('dashboard', {}) });
      if (p === '/api/funding/sweep') return json(res, 200, { ok: true, result: await S.agent('funding').trigger('dashboard', { mode: 'sweep', includeCreator: !!body.includeCreator }) });
      const rm = /^\/api\/markets\/(\d+)\/resolve$/.exec(p);
      if (rm) { const w = body.winner; if (!/^(YES|NO|REVOKE)$/.test(w || '')) return json(res, 400, { error: 'winner must be YES|NO|REVOKE' }); if (!marketById(rm[1])) return json(res, 404, { error: 'unknown market' }); log.info(`control: resolve ${rm[1]} ${w}`); await resolveMarket(Number(rm[1]), w, { reason: 'dashboard' }); return json(res, 200, { ok: true }); }
      const tm = /^\/api\/markets\/(\d+)\/trade$/.exec(p);
      if (tm) { log.info(`control: test trade ${tm[1]}`, JSON.stringify(body)); return json(res, 200, { ok: true, result: await tradeOnce({ questId: Number(tm[1]), outcome: body.outcome || 'YES', spent: Number(body.spent || 20), walletIndex: body.walletIndex }) }); }
      return json(res, 404, { error: 'not found' });
    } catch (e) { log.error('request failed:', req.url, e.message); return json(res, 500, { error: e.message.slice(0, 300) }); }
  });
  server.listen(port, '0.0.0.0', () => log.info(`dashboard listening on http://0.0.0.0:${port}${CONFIG.dashboard.token ? ' (token auth)' : ' (NO AUTH — set DASHBOARD_TOKEN before exposing)'}`));
  return server;
}
