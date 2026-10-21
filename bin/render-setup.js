// One-shot Render provisioning via the Render API (RENDER_API_KEY from Account Settings → API Keys).
//   node bin/render-setup.js --check                                → verify key, list owners/services (read-only)
//   node bin/render-setup.js [--name polyquest-bot] [--branch main] [--region singapore] [--plan starter] [--with-admin-keys]
// Creates the web service from GitHub (predictboi/pq-bot, repo root), copies the bot variables from THIS process env (values never
// printed), attaches a 1GB disk at /var/data (DATA_ROOT) and lets Render build/deploy. Re-running updates env vars only.
import { parseArgs, die, pj } from './_cli.js';

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY; if (!KEY) die('RENDER_API_KEY is not set (Render → Account Settings → API Keys; store it in the cloud environment variables).');
const a = parseArgs();
const NAME = a.name || 'polyquest-bot', BRANCH = a.branch || 'main', REGION = a.region || 'singapore', PLAN = a.plan || 'starter';
const REPO = 'https://github.com/predictboi/pq-bot';
const COPY_VARS = ['MNEMONIC', 'RPC_URL', 'DASHBOARD_TOKEN', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'TRADER_COUNT', 'ODDS_SYNC_CRON', 'DRY_RUN', ...(a['with-admin-keys'] ? ['MASTER_SECRET_KEY', 'ADMIN_SECRET_KEY'] : [])];

async function api(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Render API ${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const owners = (await api('GET', '/owners?limit=20')).map((x) => x.owner);
if (!owners.length) die('no owners visible to this API key');
const owner = a.owner ? owners.find((o) => o.name === a.owner || o.id === a.owner) : owners[0];
console.log(`Render auth OK · owner ${owner.name} (${owner.type})`);
const services = (await api('GET', `/services?limit=100&ownerId=${owner.id}`)).map((x) => x.service);
if (a.check) { pj(services.map((s) => ({ name: s.name, type: s.type, branch: s.branch, rootDir: s.rootDir, url: s.serviceDetails?.url }))); process.exit(0); }

const vars = {}; for (const k of COPY_VARS) if (process.env[k]) vars[k] = process.env[k];
Object.assign(vars, { NODE_VERSION: '22', DATA_ROOT: '/var/data', POLYQUEST_API_BASE: 'https://solana-stg.polyquest.xyz', PORT: '10000', PUBLIC_BASE_URL: `https://${NAME}.onrender.com` });
const envVars = Object.entries(vars).map(([key, value]) => ({ key, value }));

let svc = services.find((s) => s.name === NAME);
if (!svc) {
  const created = await api('POST', '/services', {
    type: 'web_service', name: NAME, ownerId: owner.id, repo: REPO, branch: BRANCH, autoDeploy: 'yes',
    serviceDetails: { env: 'node', plan: PLAN, region: REGION, healthCheckPath: '/health', envSpecificDetails: { buildCommand: 'npm ci --omit=dev', startCommand: 'npm start' }, disk: { name: `${NAME}-data`, mountPath: '/var/data', sizeGB: 1 } },
    envVars,
  });
  svc = created.service || created; console.log(`service created: ${svc.id} ${svc.serviceDetails?.url || ''}`);
} else {
  await api('PUT', `/services/${svc.id}/env-vars`, envVars); console.log(`service exists (${svc.id}); env vars updated`);
  await api('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' }); console.log('deploy triggered');
}
console.log(`variables: ${Object.keys(vars).join(', ')}`);
console.log(`\ndashboard: https://${NAME}.onrender.com  (token: DASHBOARD_TOKEN) — build takes ~2–3 min`);
