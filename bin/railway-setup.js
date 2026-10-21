// One-shot Railway provisioning (public GraphQL API, account/team token in RAILWAY_TOKEN).
//   node bin/railway-setup.js --check                       → verify token + list projects (no changes)
//   node bin/railway-setup.js --project bots --service polyquest-bot [--branch main] [--env production] [--with-admin-keys]
// Creates the project if missing, the service from GitHub (predictboi/pq-bot, repo root), copies the bot's
// variables from THIS process env (MNEMONIC, RPC_URL, DASHBOARD_TOKEN, …; values never printed), generates a public domain,
// sets PUBLIC_BASE_URL to it and triggers a deploy. Idempotent: re-running updates variables and redeploys.
import { parseArgs, die, pj } from './_cli.js';

const API = 'https://backboard.railway.com/graphql/v2';
const TOKEN = process.env.RAILWAY_TOKEN || process.env.RAILWAY_API_TOKEN;
const a = parseArgs();
const REPO = a.repo || 'predictboi/pq-bot', ROOT = a.root || '', BRANCH = a.branch || 'main';
const PROJECT = a.project || 'bots', SERVICE = a.service || 'polyquest-bot', ENV_NAME = a.env || 'production';
// High-privilege keys (master wallet = mint authority, platform admin) are NOT copied to the always-on server by default:
// they are only needed for one-off actions (funding FUNDER, creator promotion) and are used from the cloud session instead. Pass --with-admin-keys to override.
const COPY_VARS = ['MNEMONIC', 'RPC_URL', 'DASHBOARD_TOKEN', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'POLYQUEST_API_BASE', 'TRADER_COUNT', 'ODDS_SYNC_CRON', 'DRY_RUN', ...(a['with-admin-keys'] ? ['MASTER_SECRET_KEY', 'ADMIN_SECRET_KEY'] : [])];
if (!TOKEN) die('RAILWAY_TOKEN is not set (Railway → Account Settings → Tokens; store it in the cloud environment variables).');

async function gql(query, variables = {}) {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`Railway API: ${JSON.stringify(j.errors || j).slice(0, 400)}`);
  return j.data;
}
const edges = (c) => (c?.edges || []).map((e) => e.node);

async function me() { const d = await gql('query { me { id name email workspaces { id name } } }').catch(() => null); return d?.me || null; }
async function listProjects() {
  const d = await gql('query { projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }');
  return edges(d.projects).map((p) => ({ id: p.id, name: p.name, environments: edges(p.environments), services: edges(p.services) }));
}
async function ensureProject(name) {
  const found = (await listProjects()).find((p) => p.name === name); if (found) { console.log(`project "${name}" exists (${found.id})`); return found; }
  const ws = (await me())?.workspaces?.[0];
  const d = await gql('mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id name environments { edges { node { id name } } } services { edges { node { id name } } } } }', { input: { name, ...(ws?.id ? { workspaceId: ws.id } : {}) } });
  console.log(`project "${name}" created (${d.projectCreate.id})`);
  return { id: d.projectCreate.id, name, environments: edges(d.projectCreate.environments), services: edges(d.projectCreate.services) };
}
async function ensureService(project, envId) {
  const found = project.services.find((s) => s.name === SERVICE); if (found) { console.log(`service "${SERVICE}" exists (${found.id})`); return found; }
  const d = await gql('mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id name } }', { input: { projectId: project.id, name: SERVICE, source: { repo: REPO }, branch: BRANCH } });
  console.log(`service "${SERVICE}" created (${d.serviceCreate.id}) from ${REPO}@${BRANCH}`);
  return d.serviceCreate;
}
async function configureInstance(serviceId, envId) {
  await gql('mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }',
    { serviceId, environmentId: envId, input: { ...(ROOT ? { rootDirectory: ROOT } : {}), startCommand: 'npm start', healthcheckPath: '/health', restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10, source: { repo: REPO } } });
  try { await gql('mutation($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }', { id: serviceId, input: { repo: REPO, branch: BRANCH } }); } catch (e) { console.warn('serviceConnect skipped:', e.message.slice(0, 160)); }
  console.log(`instance configured: root ${ROOT || '/'}, branch ${BRANCH}, healthcheck /health`);
}
async function upsertVars(projectId, envId, serviceId, vars) {
  await gql('mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }', { input: { projectId, environmentId: envId, serviceId, variables: vars, replace: false } });
  console.log(`variables upserted: ${Object.keys(vars).join(', ')}`);
}
async function ensureDomain(serviceId, envId) {
  const d = await gql('query($serviceId: String!, $environmentId: String!) { domains(serviceId: $serviceId, environmentId: $environmentId) { serviceDomains { domain } customDomains { domain } } }', { serviceId, environmentId: envId });
  const existing = d.domains?.serviceDomains?.[0]?.domain; if (existing) { console.log(`domain exists: ${existing}`); return existing; }
  const c = await gql('mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }', { input: { serviceId, environmentId: envId } });
  console.log(`domain created: ${c.serviceDomainCreate.domain}`); return c.serviceDomainCreate.domain;
}
async function deploy(serviceId, envId) {
  try { await gql('mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }', { serviceId, environmentId: envId }); console.log('deploy triggered'); }
  catch (e) { await gql('mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }', { serviceId, environmentId: envId }); console.log('redeploy triggered'); }
}

const who = await me(); if (!who) die('token rejected by Railway (needs an account/team token, not a project token)');
console.log(`Railway auth OK: ${who.name || who.email || who.id}`);
if (a.check) { pj((await listProjects()).map((p) => ({ name: p.name, environments: p.environments.map((e) => e.name), services: p.services.map((s) => s.name) }))); process.exit(0); }

const project = await ensureProject(PROJECT);
const env = project.environments.find((e) => e.name === ENV_NAME) || project.environments[0]; if (!env) die('project has no environment');
const service = await ensureService(project, env.id);
await configureInstance(service.id, env.id);
const vars = {}; for (const k of COPY_VARS) if (process.env[k]) vars[k] = process.env[k];
vars.NODE_ENV = 'production'; vars.PORT = '8787';
const domain = await ensureDomain(service.id, env.id); vars.PUBLIC_BASE_URL = `https://${domain}`;
await upsertVars(project.id, env.id, service.id, vars);
await deploy(service.id, env.id);
console.log(`\ndashboard: https://${domain}  (token: DASHBOARD_TOKEN)`);
console.log('next: wait ~2 min for the build, then open the dashboard → Day-0 checklist.');
