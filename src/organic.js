// "Organic" trading model: pure helpers (no I/O) for persona wallets, favorite markets, time-of-day intensity,
// human-looking order sizes and Poisson arrival times. src/trader.js drives the loop with these.

/** Small deterministic PRNG (mulberry32) so personas/favorites are stable across restarts. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pickWeighted = (items, weight, r) => { const tot = items.reduce((s, x) => s + weight(x), 0); let u = r() * tot; for (const x of items) { u -= weight(x); if (u <= 0) return x; } return items[items.length - 1]; };

/** Persona types: share of wallets, how often they trade, typical size, how many markets they follow, chance to show up on a given day. */
export const PERSONAS = {
  whale: { share: 0.1, activity: 0.6, median: 450, sigma: 0.7, max: 2000, favorites: [8, 12], dailyP: 0.7 },
  active: { share: 0.27, activity: 1.6, median: 45, sigma: 0.8, max: 600, favorites: [10, 15], dailyP: 0.9 },
  casual: { share: 0.63, activity: 0.45, median: 22, sigma: 0.75, max: 250, favorites: [4, 8], dailyP: 0.35 },
};

/** Assign a persona + two favorite categories to each wallet (deterministic by wallet index). */
export function assignPersonas(wallets, categories) {
  const n = wallets.length; const nWhale = Math.max(1, Math.round(n * PERSONAS.whale.share)); const nActive = Math.round(n * PERSONAS.active.share);
  const order = wallets.map((w) => ({ w, k: rng(w.index * 7919 + 13)() })).sort((a, b) => a.k - b.k).map((x) => x.w);
  return Object.fromEntries(order.map((w, i) => {
    const type = i < nWhale ? 'whale' : i < nWhale + nActive ? 'active' : 'casual';
    const r = rng(w.index * 104729 + 7); const cats = [...categories].sort(() => r() - 0.5).slice(0, 2);
    return [w.label, { type, cats }];
  }));
}

/** Market popularity weight: Polymarket 24h volume (log-scaled), boosted near the end date. */
export function popularity(m, now = Date.now()) {
  const vol = Number(m.polymarket?.volume24hr || 0); let w = 1 + Math.log10(1 + vol);
  const end = m.endDate ? new Date(m.endDate).getTime() : NaN;
  if (Number.isFinite(end)) { const days = (end - now) / 86400000; if (days >= 0 && days < 2) w *= 2.5; else if (days < 7) w *= 1.5; }
  return w;
}

/**
 * Favorite markets per wallet: keep the ones still live, then fill up to the persona's count, preferring the wallet's
 * two categories (×3) and popular markets. Deterministic per (wallet, day) so it changes slowly.
 */
export function assignFavorites(personas, markets, prev = {}, { day = 0 } = {}) {
  const live = new Map(markets.map((m) => [m.questId, m])); const out = {};
  for (const [label, p] of Object.entries(personas)) {
    const spec = PERSONAS[p.type]; const r = rng(hashStr(label) + day * 31);
    const want = Math.round(spec.favorites[0] + r() * (spec.favorites[1] - spec.favorites[0]));
    const keep = (prev[label] || []).filter((q) => live.has(q)).slice(0, want);
    const pool = markets.filter((m) => !keep.includes(m.questId));
    while (keep.length < want && pool.length) {
      const m = pickWeighted(pool, (x) => popularity(x) * (p.cats.includes(x.category) ? 3 : 1), r);
      keep.push(m.questId); pool.splice(pool.indexOf(m), 1);
    }
    out[label] = keep;
  }
  return out;
}
export function hashStr(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Relative intensity for an hour (UTC): US evening (00–04 UTC) and KR evening (10–14 UTC) peaks, quiet 17–22 UTC. */
export const HOUR_WEIGHTS = [1.6, 1.8, 1.7, 1.4, 1.0, 0.6, 0.4, 0.35, 0.4, 0.6, 1.1, 1.4, 1.5, 1.4, 1.2, 1.0, 0.8, 0.5, 0.35, 0.3, 0.35, 0.5, 0.8, 1.2];

/** Expected trades per second at time t (Date). */
export function rateAt(t, { tradesPerDay = 800, weekendFactor = 0.8, hourWeights = HOUR_WEIGHTS } = {}) {
  const sum = hourWeights.reduce((a, x) => a + x, 0); const h = t.getUTCHours(); const dow = t.getUTCDay();
  const day = dow === 0 || dow === 6 ? weekendFactor : 1;
  return (tradesPerDay * (hourWeights[h] / sum) * day) / 3600;
}

/** Exponential gap (ms) for a Poisson process at `ratePerSec`. */
export const nextGapMs = (ratePerSec, r = Math.random) => Math.round((-Math.log(1 - r()) / Math.max(ratePerSec, 1e-6)) * 1000);

const ROUND = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
/** Log-normal size around the persona median; 65% snap to a round number, else to 0.5. */
export function orderSize(type, r = Math.random) {
  const s = PERSONAS[type]; const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  let x = Math.min(s.max, Math.max(2, s.median * Math.exp(s.sigma * z)));
  if (r() < 0.65) x = ROUND.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), ROUND[0]);
  else x = Math.round(x * 2) / 2;
  return x;
}
