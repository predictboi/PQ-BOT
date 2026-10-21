// Persistent state: addresses.json (committed, no secrets), markets.json (questId ↔ Polymarket mapping), settings.json (dashboard overrides).
import path from 'node:path';
import { PATHS, DEFAULT_SETTINGS } from './config.js';
import { readJson, writeJson, ensureDir, nowIso } from './util.js';

const F = {
  addresses: path.join(PATHS.state, 'addresses.json'),
  markets: path.join(PATHS.state, 'markets.json'),
  settings: path.join(PATHS.state, 'settings.json'),
  runtime: path.join(PATHS.state, 'runtime.json'),
};
export const FILES = F;

// ---- addresses ----
const PACKAGED_ADDRESSES = path.join(PATHS.root, 'state', 'addresses.json');
export const loadAddresses = () => { const a = readJson(F.addresses, null); return a || readJson(PACKAGED_ADDRESSES, { wallets: [] }); };
export const saveAddresses = (wallets) => writeJson(F.addresses, { generatedAt: nowIso(), derivation: "m/44'/501'/{index}'/0'", wallets });

// ---- settings (deep-merge defaults ← file) ----
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function merge(a, b) { const o = { ...a }; for (const k of Object.keys(b || {})) o[k] = isObj(a?.[k]) && isObj(b[k]) ? merge(a[k], b[k]) : b[k]; return o; }
let _settings = null;
export function getSettings() { if (!_settings) _settings = merge(DEFAULT_SETTINGS, readJson(F.settings, {})); return _settings; }
export function updateSettings(patch) { _settings = merge(getSettings(), patch); writeJson(F.settings, _settings); return _settings; }

// ---- markets ----
// market: { questId, title, categoryId, category, answers:[{id,title}], yesAnswerId, noAnswerId, endDate, status, createdAt,
//           polymarket: { id, conditionId, slug, eventSlug, question, tokenIds:[yes,no], url } | null, openingRatios, imageUrl, resolution?, lastSync? }
let _markets = null;
export function loadMarkets() { if (!_markets) _markets = readJson(F.markets, { markets: [] }); if (!Array.isArray(_markets.markets)) _markets.markets = []; return _markets; }
export function saveMarkets() { const m = loadMarkets(); m.updatedAt = nowIso(); writeJson(F.markets, m); }
export const allMarkets = () => loadMarkets().markets;
export const marketById = (questId) => allMarkets().find((m) => Number(m.questId) === Number(questId));
export function upsertMarket(rec) {
  const list = loadMarkets().markets; const i = list.findIndex((m) => Number(m.questId) === Number(rec.questId));
  if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec);
  saveMarkets(); return rec;
}
export function patchMarket(questId, patch) { const m = marketById(questId); if (!m) return null; Object.assign(m, patch); saveMarkets(); return m; }
/** Live = APPROVED and endDate in the future. */
export const liveMarkets = () => allMarkets().filter((m) => m.status === 'APPROVED' && (!m.endDate || new Date(m.endDate) > new Date()));
export const isMapped = (m) => !!m.polymarket?.id;

// ---- runtime (last snapshot of balances etc., for the dashboard) ----
export const loadRuntime = () => readJson(F.runtime, {});
export function patchRuntime(patch) { const r = { ...loadRuntime(), ...patch, updatedAt: nowIso() }; writeJson(F.runtime, r); return r; }

ensureDir(PATHS.state); ensureDir(PATHS.reports); ensureDir(PATHS.thumbs);
