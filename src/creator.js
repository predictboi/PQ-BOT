// CREATOR bot: keep each category at its target number of live markets, create via the user flow, keep markets.json in sync.
import { CONFIG, CATEGORIES, categoryById } from './config.js';
import { CREATOR } from './wallets.js';
import * as pq from './client/polyquest.js';
import { thumbnailFor } from './images.js';
import { pickTopics, manualTopics } from './research.js';
import { marketBySlug } from './polymarket.js';
import { getSettings, allMarkets, liveMarkets, upsertMarket, patchMarket, marketById } from './state.js';
import { createLogger, sleep, appendJsonl } from './util.js';
import path from 'node:path';
import { PATHS } from './config.js';

const log = createLogger('creator');
const REPORT = path.join(PATHS.reports, 'creator.jsonl');

/** Login as CREATOR and read the platform role (USER until promoted in /admin). */
export async function creatorStatus() {
  const kp = CREATOR(); const sess = await pq.sessions.get(kp); const info = await pq.sessionInfo(sess);
  const role = info?.user?.role || 'USER';
  return { address: kp.publicKey.toBase58(), role, promoted: role === 'CREATOR' || role === 'ADMIN', email: info?.user?.email || null };
}

const pmFromLink = (link) => { const m = /polymarket\.com\/event\/([^/]+)\/([^/?#]+)/.exec(link || ''); return m ? { eventSlug: m[1], slug: m[2] } : null; };

/** Pull every quest created by CREATOR from the platform and merge into markets.json (status, endDate, answers). */
export async function syncFromPlatform() {
  const kp = CREATOR(); const addr = kp.publicKey.toBase58();
  const quests = await pq.sessions.withSession(kp, (sess) => pq.allQuestsByWallet(sess, addr));
  let added = 0, updated = 0, recovered = 0;
  for (const q of quests) {
    if (q.type !== 'LSLMSR') continue;
    const answers = (q.answers || []).map((a) => ({ id: a.id, title: a.title }));
    const yes = answers.find((a) => /^(예|yes)$/i.test(a.title)) || answers[0], no = answers.find((a) => /^(아니오|no)$/i.test(a.title)) || answers[1];
    const existing = marketById(q.id);
    const rec = { questId: q.id, title: q.title, categoryId: q.categoryId, category: q.category?.name || categoryById(q.categoryId)?.name || null, answers, yesAnswerId: yes?.id, noAnswerId: no?.id, endDate: q.endDate, status: q.status, finalAnswerId: q.finalAnswerId ?? null, totalAmount: Number(q.totalAmount || 0), imageUrl: q.imageUrl, relevantLink: q.relevantLink, percent: (q.answers || []).map((a) => a.percent), platformUpdatedAt: q.updatedAt };
    if (!existing) { rec.createdAt = q.createdAt; rec.polymarket = null; const pm = pmFromLink(q.relevantLink); if (pm) rec.polymarket = { ...pm, recoveredFromLink: true, id: null, tokenIds: [] }; added++; }
    else updated++;
    const pmRef = rec.polymarket || existing?.polymarket;
    if (pmRef && !pmRef.id && pmRef.slug) { try { const g = await marketBySlug(pmRef.slug); if (g) { rec.polymarket = { id: g.id, conditionId: g.conditionId, slug: g.slug, eventSlug: g.eventSlug || pmRef.eventSlug, question: g.question, tokenIds: g.tokenIds, url: g.url, recovered: true }; recovered++; } } catch { /* keep slug-only mapping */ } }
    upsertMarket(rec);
  }
  return { total: quests.length, added, updated, recovered };
}

export function liveCountByCategory() {
  const live = liveMarkets(); const out = {};
  for (const c of CATEGORIES) out[c.name] = live.filter((m) => Number(m.categoryId) === c.id).length;
  return out;
}
export function shortfall() {
  const targets = getSettings().categoryTargets; const live = liveCountByCategory(); const out = {};
  for (const c of CATEGORIES) { const t = Number(targets[c.name] ?? 0); out[c.name] = { target: t, live: live[c.name] || 0, need: Math.max(0, t - (live[c.name] || 0)) }; }
  return out;
}

/** Create one market from a spec via the user flow; returns the stored market record. */
export async function createFromSpec(spec) {
  const kp = CREATOR(); const sess = await pq.sessions.get(kp);
  const img = await thumbnailFor(spec);
  const res = await pq.createMarket(sess, kp, { ...spec, imageUrl: img.url, seed: CONFIG.market.seed, alpha: CONFIG.market.alpha });
  if (res.dryRun) return { dryRun: true, spec };
  await sleep(3000);
  let det = null; try { det = await pq.questDetail(res.questId); } catch { /* read later */ }
  const answers = (det?.answers || res.answers || []).map((a) => ({ id: a.id, title: a.title }));
  const yes = answers.find((a) => /^(예|yes)$/i.test(a.title)) || answers[0], no = answers.find((a) => /^(아니오|no)$/i.test(a.title)) || answers[1];
  const rec = { questId: res.questId, title: spec.title, categoryId: spec.categoryId, category: spec.category, answers, yesAnswerId: yes?.id, noAnswerId: no?.id, endDate: spec.endDateISO, status: det?.status || 'APPROVED', createdAt: new Date().toISOString(), polymarket: spec.polymarket, manual: spec.manual || null, openingRatios: spec.openingRatios, imageUrl: det?.imageUrl || img.url, relevantLink: spec.relevantLink, thumbSource: img.source };
  upsertMarket(rec);
  appendJsonl(REPORT, { t: new Date().toISOString(), event: 'created', questId: res.questId, title: spec.title, category: spec.category, openingRatios: spec.openingRatios, pm: spec.polymarket?.slug || null });
  log.info(`created quest ${res.questId} [${spec.category}] ${spec.title} (${spec.openingRatios.join('/')})`);
  return rec;
}

/** Main loop body: sync, then create the shortfall per category (bounded by maxCreatePerRun). */
export async function replenish({ maxCreate } = {}) {
  const s = getSettings().creator; const limit = maxCreate ?? s.maxCreatePerRun;
  const sync = await syncFromPlatform().catch((e) => ({ error: e.message }));
  const st = await creatorStatus();
  if (!st.promoted) { log.warn(`CREATOR ${st.address} role=${st.role} — not promoted yet; skipping creation`); return { sync, creator: st, created: [], failed: [], skipped: 'not-promoted', shortfall: shortfall() };
  }
  const created = [], failed = []; let budget = limit;
  for (const spec of manualTopics()) { if (budget <= 0) break; try { created.push(await createFromSpec(spec)); budget--; await sleep(s.pauseMs); } catch (e) { failed.push({ title: spec.title, error: e.message.slice(0, 160) }); } }
  for (const c of CATEGORIES) {
    if (budget <= 0) break;
    const { need } = shortfall()[c.name]; if (need <= 0) continue;
    let specs = []; try { specs = await pickTopics(c.id, Math.min(need, budget), { minDays: s.endDateMinDays, maxDays: s.endDateMaxDays }); } catch (e) { failed.push({ category: c.name, error: `research: ${e.message.slice(0, 120)}` }); continue; }
    for (const spec of specs) { if (budget <= 0) break; try { created.push(await createFromSpec(spec)); budget--; await sleep(s.pauseMs); } catch (e) { failed.push({ title: spec.title, category: c.name, error: e.message.slice(0, 160) }); log.error('create failed:', spec.title, e.message.slice(0, 160)); } }
  }
  return { sync, creator: st, created: created.map((m) => ({ questId: m.questId, title: m.title, category: m.category })), failed, shortfall: shortfall() };
}

/** Refresh status/percent for all local markets from the platform (cheap; used by reporter/trader). */
export async function refreshMarketStatuses() {
  let n = 0;
  for (const m of allMarkets()) {
    if (m.status !== 'APPROVED') continue;
    try { const d = await pq.questDetail(m.questId); patchMarket(m.questId, { status: d.status, finalAnswerId: d.finalAnswerId ?? null, totalAmount: Number(d.totalAmount || 0), percent: (d.answers || []).map((a) => a.percent), platformUpdatedAt: d.updatedAt }); n++; } catch { /* ignore */ }
  }
  return n;
}
