import test from 'node:test';
import assert from 'node:assert/strict';
import { assignPersonas, assignFavorites, rateAt, orderSize, nextGapMs, PERSONAS } from '../src/organic.js';

const wallets = Array.from({ length: 30 }, (_, i) => ({ index: i + 2, label: `TRADER-${String(i + 1).padStart(2, '0')}` }));
const cats = ['Politics', 'Sports', 'Crypto', 'Economics', 'Culture', 'Science', 'Social', 'Other'];
const markets = Array.from({ length: 80 }, (_, i) => ({ questId: 900000 + i, category: cats[i % 8], polymarket: { volume24hr: (i * 7919) % 50000 }, endDate: new Date(Date.now() + 30 * 86400000).toISOString() }));

test('personas: 3 whales, 8 active, 19 casual; stable across calls', () => {
  const p = assignPersonas(wallets, cats); const n = (t) => Object.values(p).filter((x) => x.type === t).length;
  assert.deepEqual([n('whale'), n('active'), n('casual')], [3, 8, 19]);
  assert.deepEqual(p, assignPersonas(wallets, cats));
});

test('favorites: persona-sized, live only, keeps still-live previous picks', () => {
  const p = assignPersonas(wallets, cats); const f = assignFavorites(p, markets, {}, { day: 1 });
  for (const [label, qs] of Object.entries(f)) { const [lo, hi] = PERSONAS[p[label].type].favorites; assert.ok(qs.length >= lo && qs.length <= hi, label); assert.equal(new Set(qs).size, qs.length); }
  const prev = { 'TRADER-01': [900003, 123] }; const f2 = assignFavorites(p, markets, prev, { day: 2 });
  assert.ok(f2['TRADER-01'].includes(900003)); assert.ok(!f2['TRADER-01'].includes(123));
});

test('rate: a weekday integrates to tradesPerDay, quiet hours are quieter', () => {
  const day = Date.UTC(2026, 9, 21); let sum = 0; for (let h = 0; h < 24; h++) sum += rateAt(new Date(day + h * 3600000), { tradesPerDay: 800 }) * 3600;
  assert.ok(Math.abs(sum - 800) < 1e-6);
  assert.ok(rateAt(new Date(day + 1 * 3600000)) > 4 * rateAt(new Date(day + 19 * 3600000)));
});

test('order sizes: within persona bounds, mostly small', () => {
  const xs = Array.from({ length: 4000 }, () => orderSize('casual')); xs.sort((a, b) => a - b);
  assert.ok(xs[0] >= 2 && xs.at(-1) <= PERSONAS.casual.max);
  const med = xs[2000]; assert.ok(med >= 15 && med <= 30, `median ${med}`);
  const w = Array.from({ length: 2000 }, () => orderSize('whale')); assert.ok(Math.max(...w) <= 2000);
});

test('poisson gaps average 1/rate', () => {
  const g = Array.from({ length: 20000 }, () => nextGapMs(0.01)); const mean = g.reduce((a, x) => a + x, 0) / g.length;
  assert.ok(Math.abs(mean - 100000) < 5000, `mean ${mean}`);
});
