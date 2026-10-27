// Polymarket public read API (Gamma + CLOB). No keys. Field names verified 2026-10-20:
//   GET gamma/events?tag_slug=&active=true&closed=false → [{ id, slug, title, endDate, volume, liquidity, markets:[...] }]
//   market: { id, question, conditionId, slug, outcomes:'["Yes","No"]', outcomePrices:'["0.62","0.38"]', clobTokenIds:'[..]',
//             endDate, closed, acceptingOrders, volumeNum, volume24hr, liquidityNum, bestBid, bestAsk, lastTradePrice, umaResolutionStatus, groupItemTitle }
//   GET clob/midpoint?token_id= → { mid }
import { CONFIG } from './config.js';
import { withTimeout, retry } from './util.js';

const G = CONFIG.polymarket.gamma, C = CONFIG.polymarket.clob;
const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
async function getJson(url, label) {
  return retry(async () => { const r = await withTimeout(fetch(url, { headers: { accept: 'application/json' } }), 20000, label); if (!r.ok) throw new Error(`${label} HTTP ${r.status}`); return r.json(); }, { tries: 3, delayMs: 1200, label });
}

/** Normalize a Gamma market into our shape (prices as numbers, tokenIds parsed). */
export function normalizeMarket(m, ev = {}) {
  const outcomes = j(m.outcomes, []); const prices = j(m.outcomePrices, []).map(Number); const tokenIds = j(m.clobTokenIds, []);
  const yes = outcomes.findIndex((o) => /^yes$/i.test(o));
  const yi = yes >= 0 ? yes : 0, ni = yi === 0 ? 1 : 0;
  return {
    id: String(m.id), question: m.question, conditionId: m.conditionId, slug: m.slug,
    eventId: ev.id ? String(ev.id) : null, eventSlug: ev.slug || null, eventTitle: ev.title || null, groupItemTitle: m.groupItemTitle || null,
    outcomes, isBinary: outcomes.length === 2 && yes >= 0,
    yesPrice: prices[yi], noPrice: prices[ni], tokenIds: [tokenIds[yi], tokenIds[ni]],
    bestBid: m.bestBid != null ? Number(m.bestBid) : null, bestAsk: m.bestAsk != null ? Number(m.bestAsk) : null, lastTradePrice: m.lastTradePrice != null ? Number(m.lastTradePrice) : null,
    endDate: m.endDate || m.endDateIso, startDate: m.startDate, gameStartTime: m.gameStartTime || null, closed: !!m.closed, active: !!m.active, acceptingOrders: !!m.acceptingOrders,
    volume: Number(m.volumeNum ?? m.volume ?? 0), volume24hr: Number(m.volume24hr ?? 0), liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
    umaResolutionStatus: m.umaResolutionStatus || null, resolutionSource: m.resolutionSource || ev.resolutionSource || '', description: m.description || '',
    eventMarketCount: ev.markets?.length ?? 1, image: m.image || ev.image || null,
    url: ev.slug ? `https://polymarket.com/event/${ev.slug}${m.slug ? '/' + m.slug : ''}` : (m.slug ? `https://polymarket.com/market/${m.slug}` : null),
  };
}

export async function eventsByTag(tag, { limit = 100, order = 'volume24hr' } = {}) {
  return getJson(`${G}/events?tag_slug=${encodeURIComponent(tag)}&active=true&closed=false&limit=${limit}&order=${order}&ascending=false`, `gamma events ${tag}`);
}
export async function marketBySlug(slug) { const arr = await getJson(`${G}/markets?slug=${encodeURIComponent(slug)}`, `gamma market slug ${slug}`); const m = Array.isArray(arr) ? arr[0] : null; return m ? normalizeMarket(m, m.events?.[0] || {}) : null; }
export async function marketById(id) { const m = await getJson(`${G}/markets/${encodeURIComponent(id)}`, `gamma market ${id}`); return normalizeMarket(m, m.events?.[0] || {}); }

/** Flatten open binary markets for a list of tags, deduped by conditionId, sorted by volume24hr desc. */
export async function candidateMarkets(tags, { minDays = 3, maxDays = 90, limitPerTag = 100 } = {}) {
  const now = Date.now(); const seen = new Set(); const out = [];
  for (const tag of tags) {
    let evs = []; try { evs = await eventsByTag(tag, { limit: limitPerTag }); } catch { continue; }
    for (const ev of evs) for (const raw of ev.markets || []) {
      const m = normalizeMarket(raw, ev);
      if (!m.isBinary || m.closed || !m.acceptingOrders || seen.has(m.conditionId)) continue;
      const end = new Date(m.endDate).getTime(); if (!Number.isFinite(end)) continue;
      const days = (end - now) / 86400000; if (days < minDays || days > maxDays) continue;
      if (!(m.yesPrice > 0.03 && m.yesPrice < 0.97)) continue; // skip near-settled markets
      seen.add(m.conditionId); out.push({ ...m, tag, daysToEnd: days });
    }
  }
  return out.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0) || (b.liquidity || 0) - (a.liquidity || 0));
}

/** Live YES probability: CLOB midpoint → (bid+ask)/2 → lastTrade → gamma outcomePrices. Returns { p, source }. */
export async function yesProbability(pm) {
  const tokenId = pm?.tokenIds?.[0];
  if (tokenId) {
    try { const r = await getJson(`${C}/midpoint?token_id=${tokenId}`, 'clob midpoint'); const mid = Number(r?.mid); if (mid > 0 && mid < 1) return { p: mid, source: 'clob-mid' }; } catch { /* fall through */ }
  }
  try {
    const m = await marketById(pm.id);
    if (m.bestBid != null && m.bestAsk != null && m.bestAsk > 0) return { p: (m.bestBid + m.bestAsk) / 2, source: 'gamma-bidask', market: m };
    if (m.lastTradePrice != null) return { p: m.lastTradePrice, source: 'gamma-last', market: m };
    if (m.yesPrice != null) return { p: m.yesPrice, source: 'gamma-price', market: m };
  } catch { /* ignore */ }
  return { p: null, source: 'none' };
}

/** Resolution status of a market: { state:'open'|'resolved'|'voided'|'closed-unresolved', winner:'YES'|'NO'|null } */
export function resolutionOf(m) {
  if (!m.closed) return { state: 'open', winner: null };
  const y = Number(m.yesPrice), n = Number(m.noPrice);
  const resolved = m.umaResolutionStatus === 'resolved' || (y === 1 && n === 0) || (y === 0 && n === 1);
  if (resolved && y >= 0.99) return { state: 'resolved', winner: 'YES' };
  if (resolved && n >= 0.99) return { state: 'resolved', winner: 'NO' };
  if (resolved && Math.abs(y - 0.5) < 0.02) return { state: 'voided', winner: null }; // 50/50 split = market voided
  return { state: 'closed-unresolved', winner: null };
}
