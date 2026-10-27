import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarket, resolutionOf } from '../src/polymarket.js';
import { planMove, assignChunks, FEE_BUFFER } from '../src/oddsSync.js';
import { LsLmsr } from '../src/lslmsr.js';
import { ratiosFromYes } from '../src/research.js';

const raw = { id: '1', question: 'Will X?', conditionId: '0xabc', slug: 'will-x', outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', clobTokenIds: '["111","222"]', endDate: '2027-01-01T00:00:00Z', closed: false, acceptingOrders: true, volumeNum: 10, volume24hr: 5, bestBid: 0.61, bestAsk: 0.63 };
test('normalizeMarket parses JSON-string fields and maps YES/NO', () => {
  const m = normalizeMarket(raw, { slug: 'ev', title: 'Ev', markets: [raw] });
  assert.equal(m.isBinary, true); assert.equal(m.yesPrice, 0.62); assert.deepEqual(m.tokenIds, ['111', '222']); assert.equal(m.url, 'https://polymarket.com/event/ev/will-x');
});
test('resolutionOf', () => {
  assert.deepEqual(resolutionOf({ closed: false }), { state: 'open', winner: null });
  assert.deepEqual(resolutionOf({ closed: true, yesPrice: 1, noPrice: 0, umaResolutionStatus: 'resolved' }), { state: 'resolved', winner: 'YES' });
  assert.deepEqual(resolutionOf({ closed: true, yesPrice: 0, noPrice: 1, umaResolutionStatus: 'resolved' }), { state: 'resolved', winner: 'NO' });
  assert.deepEqual(resolutionOf({ closed: true, yesPrice: 0.5, noPrice: 0.5, umaResolutionStatus: 'resolved' }), { state: 'voided', winner: null });
});
test('planMove skips inside band, bounds the move, splits across wallets', () => {
  const model = new LsLmsr({ outcomes: 2, alpha: 0.05, seed: 15000, seedMode: 'cost' });
  const common = { model, band: 0.02, maxMove: 0.08, maxSpend: 3000, walletsMin: 2, walletsMax: 4 };
  assert.equal(planMove({ p: 0.5, pStar: 0.51, ...common }).skip, true);
  const up = planMove({ p: 0.5, pStar: 0.7, ...common });
  assert.equal(up.skip, false); assert.equal(up.outcome, 'YES'); assert.equal(up.target, 0.58); assert.ok(up.chunks.length >= 2 && up.chunks.length <= 4); assert.equal(up.chunks.reduce((a, b) => a + b, 0), up.spend);
  const down = planMove({ p: 0.5, pStar: 0.3, ...common });
  assert.equal(down.outcome, 'NO'); assert.equal(down.target, 0.42);
});
test('ratiosFromYes clamps and sums to 100', () => { assert.deepEqual(ratiosFromYes(0.62), ['62', '38']); assert.deepEqual(ratiosFromYes(0.01), ['5', '95']); });

test('assignChunks: only wallets that can pay amount + fee, budgets tracked across chunks', () => {
  const pool = [{ w: { label: 'A' }, usdp: 2000 }, { w: { label: 'B' }, usdp: 300 }, { w: { label: 'C' }, usdp: 900 }];
  const out = assignChunks([750, 750, 750], pool);
  assert.deepEqual(out.map((o) => [o.w.label, o.spent, o.shrunk]), [['A', 750, false], ['C', 750, false], ['A', 750, false]]);
  // nobody covers the chunk → richest wallet, shrunk to what it can afford; dust chunks dropped
  const poor = assignChunks([750, 750], [{ w: { label: 'X' }, usdp: 420 }]);
  assert.deepEqual(poor.map((o) => [o.w.label, o.spent, o.shrunk]), [['X', Math.floor(420 / FEE_BUFFER), true]]);
  assert.deepEqual(assignChunks([500], []), []);
});
