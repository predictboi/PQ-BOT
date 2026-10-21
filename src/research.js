// Topic research: Polymarket markets by category → Polyquest market specs (English title/description, PM odds as opening ratios).
// Writer: Claude (ANTHROPIC_API_KEY) when available, otherwise a deterministic template (original question + resolution frame).
// Manual topics (not on Polymarket) go in topics/manual.json: [{ categoryId, title, description, endDate, yesProb, imageSubject, targetOdds }]
import path from 'node:path';
import { CONFIG, PATHS, categoryById } from './config.js';
import { candidateMarkets } from './polymarket.js';
import { allMarkets } from './state.js';
import { createLogger, readJson } from './util.js';

const log = createLogger('research');

export function ratiosFromYes(p) { const y = Math.round(Math.min(0.95, Math.max(0.05, p)) * 100); return [String(y), String(100 - y)]; }
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** Template writer (no LLM): keeps the original question so it stays unambiguous. */
export function templateSpec(pm, cat) {
  const q = pm.eventMarketCount > 1 && pm.groupItemTitle && !pm.question.includes(pm.groupItemTitle) ? `${pm.eventTitle} — ${pm.groupItemTitle}` : pm.question;
  return {
    title: q.length > 120 ? q.slice(0, 117) + '…' : q,
    description: `${q}\n\nResolution: follows the official resolution of the same Polymarket market (${pm.url}). Closes: ${fmtDate(pm.endDate)} (UTC). Collateral: USDP. Category: ${cat.name}.` + (pm.resolutionSource ? `\nSource: ${pm.resolutionSource}` : ''),
    imageSubject: null,
  };
}

async function claudeWriter(items) {
  if (!CONFIG.anthropic.apiKey || items.length === 0) return null;
  let Anthropic; try { Anthropic = (await import('@anthropic-ai/sdk')).default; } catch { log.warn('@anthropic-ai/sdk not installed; using template titles'); return null; }
  const client = new Anthropic({ apiKey: CONFIG.anthropic.apiKey });
  const system = 'You write English prediction-market listings for Polyquest. For each input market return a JSON array (same order) of objects {"title": string, "description": string, "imageSubject": string}. ' +
    'title: natural English, ≤ 80 chars, must keep the exact threshold/date/entity of the original question (do not reinterpret), end with "?". ' +
    'description: 2–4 English sentences: what resolves YES, the resolution source (the Polymarket market URL + original source), the deadline. ' +
    'imageSubject: one English phrase describing a single hero subject for a text-free thumbnail. Output ONLY the JSON array.';
  const user = JSON.stringify(items.map((pm) => ({ question: pm.question, event: pm.eventTitle, groupItem: pm.groupItemTitle, endDate: pm.endDate, description: (pm.description || '').slice(0, 600), url: pm.url })));
  const res = await client.beta.messages.create({
    model: CONFIG.anthropic.model, max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low' },
    system, messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude refused: ${res.stop_details?.category || ''}`);
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\[[\s\S]*\]/); if (!m) throw new Error('writer returned no JSON array');
  const arr = JSON.parse(m[0]); if (!Array.isArray(arr) || arr.length !== items.length) throw new Error('writer array length mismatch');
  return arr;
}

/** Build specs for `need` new markets in a category. */
export async function pickTopics(categoryId, need, { minDays, maxDays } = {}) {
  const cat = categoryById(categoryId); if (!cat) throw new Error(`unknown category ${categoryId}`);
  const used = new Set(allMarkets().map((m) => m.polymarket?.conditionId).filter(Boolean));
  const usedTitles = new Set(allMarkets().map((m) => m.title));
  const cands = (await candidateMarkets(cat.tags, { minDays, maxDays })).filter((m) => !used.has(m.conditionId));
  // prefer single-market events (clean questions), then volume; one market per event (avoids complementary pairs like D-House / R-House)
  const perEvent = {}; const chosen = [];
  const score = (m) => (m.volume24hr || 0) * (m.eventMarketCount === 1 ? 1.5 : 1) + (m.liquidity || 0) * 0.05; // liquid, active markets first; single-market events get a bonus
  for (const m of [...cands].sort((a, b) => score(b) - score(a))) {
    const k = m.eventSlug || m.id; perEvent[k] = (perEvent[k] || 0) + 1; if (perEvent[k] > 1) continue;
    chosen.push(m); if (chosen.length >= need) break;
  }
  let written = null; try { written = await claudeWriter(chosen); } catch (e) { log.warn('Claude writer failed, falling back to template:', e.message); }
  const specs = chosen.map((pm, i) => {
    const w = written?.[i] || templateSpec(pm, cat);
    if (usedTitles.has(w.title)) w.title = `${w.title} (${pm.groupItemTitle || pm.id})`;
    return {
      title: w.title, description: w.description, imageSubject: w.imageSubject || null,
      endDateISO: new Date(pm.endDate).toISOString(), openingRatios: ratiosFromYes(pm.yesPrice), categoryId: cat.id, category: cat.name,
      relevantLink: pm.url, answers: [{ title: 'Yes' }, { title: 'No' }],
      polymarket: { id: pm.id, conditionId: pm.conditionId, slug: pm.slug, eventSlug: pm.eventSlug, question: pm.question, tokenIds: pm.tokenIds, url: pm.url, yesAtCreate: pm.yesPrice, volume24hr: pm.volume24hr },
    };
  });
  log.info(`category ${cat.name}: ${cands.length} candidates → ${specs.length} specs (need ${need})`);
  return specs;
}

/** Manual topics file → specs (only ones not yet created). */
export function manualTopics() {
  const list = readJson(path.join(PATHS.topics, 'manual.json'), []);
  const usedTitles = new Set(allMarkets().map((m) => m.title));
  return (Array.isArray(list) ? list : []).filter((t) => t.title && !usedTitles.has(t.title) && new Date(t.endDate) > new Date()).map((t) => ({
    title: t.title, description: t.description || t.title, imageSubject: t.imageSubject || null, endDateISO: new Date(t.endDate).toISOString(),
    openingRatios: ratiosFromYes(Number(t.yesProb ?? 0.5)), categoryId: Number(t.categoryId || 8), category: categoryById(t.categoryId || 8)?.name || 'Other',
    relevantLink: t.link || null, answers: [{ title: 'Yes' }, { title: 'No' }], polymarket: null, manual: { targetOdds: t.targetOdds ?? null },
  }));
}
